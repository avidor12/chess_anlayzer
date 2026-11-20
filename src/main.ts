import "./style.css";
import "./pieces.css";
import { Engine, type SearchResult } from "./engine";
import {
  START_FEN,
  checkPosition,
  emptyGrid,
  gameStatus,
  placementToGrid,
  possibleCastling,
  pvToSan,
  rotateGrid,
  toFen,
  type Castling,
  type Grid,
  type Side,
} from "./position";
import {
  apply,
  classifySquares,
  decide,
  guessWhiteSide,
  loadImage,
  loadModels,
  orderCorners,
  perspective,
  type LoadedImage,
} from "./vision";

// ---------- helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

/** CSS class for a FEN piece char, e.g. "N" -> "wN", "q" -> "bQ". */
const pieceClass = (p: string) => (p === p.toUpperCase() ? "w" : "b") + p.toUpperCase();
const FILES = "abcdefgh";

// ---------- state ----------
let grid: Grid = placementToGrid(START_FEN.split(" ")[0]);
let flipped = false;
let selected: [number, number] | null = null;
let turn: Side = "w";
let movetime = 4000;
let results: Partial<Record<Side, { fen: string; res?: SearchResult; error?: string }>> = {};
let analysing = false;
/** Squares the scanner was unsure about (board orientation), shown outlined until edited. */
let unsure: boolean[][] | null = null;

const saved = store.get("position");
if (saved) {
  try {
    grid = placementToGrid(saved);
  } catch {
    /* ignore */
  }
}

let engine: Engine | null = null;
function getEngine() {
  if (!engine) engine = new Engine(`${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`);
  return engine;
}

// ---------- board rendering ----------
const boardEl = $("board");
const arrowsEl = $("arrows") as unknown as SVGSVGElement;

function renderBoard() {
  boardEl.innerHTML = "";
  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const r = flipped ? 7 - vr : vr;
      const c = flipped ? 7 - vc : vc;
      const sq = document.createElement("button");
      sq.className = `sq ${(r + c) % 2 === 0 ? "light" : "dark"}`;
      if (selected && selected[0] === r && selected[1] === c) sq.classList.add("sel");
      if (unsure?.[r][c]) sq.classList.add("unsure");
      sq.setAttribute("aria-label", `${FILES[c]}${8 - r}`);
      const p = grid[r][c];
      if (p) {
        const span = document.createElement("span");
        span.className = `pc ${pieceClass(p)}`;
        sq.appendChild(span);
      }
      if (vc === 0) sq.insertAdjacentHTML("beforeend", `<i class="coord rank">${8 - r}</i>`);
      if (vr === 7) sq.insertAdjacentHTML("beforeend", `<i class="coord file">${FILES[c]}</i>`);
      sq.addEventListener("click", () => onSquare(r, c));
      boardEl.appendChild(sq);
    }
  }
  renderArrows();
}

function squareCenter(sq: string): [number, number] {
  const c = FILES.indexOf(sq[0]);
  const r = 8 - Number(sq[1]);
  const vc = flipped ? 7 - c : c;
  const vr = flipped ? 7 - r : r;
  return [vc * 100 + 50, vr * 100 + 50];
}

function renderArrows() {
  arrowsEl.querySelectorAll("line").forEach((l) => l.remove());
  const draw = (uci: string | undefined, color: string, marker: string) => {
    if (!uci) return;
    const [x1, y1] = squareCenter(uci.slice(0, 2));
    const [x2, y2] = squareCenter(uci.slice(2, 4));
    const len = Math.hypot(x2 - x1, y2 - y1);
    const shorten = 28;
    const ex = x2 - ((x2 - x1) / len) * shorten;
    const ey = y2 - ((y2 - y1) / len) * shorten;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    Object.entries({
      x1,
      y1,
      x2: ex,
      y2: ey,
      stroke: color,
      "stroke-width": 16,
      "stroke-linecap": "round",
      opacity: 0.85,
      "marker-end": `url(#${marker})`,
    }).forEach(([k, v]) => line.setAttribute(k, String(v)));
    arrowsEl.appendChild(line);
  };
  draw(results.w?.res?.lines[0]?.pv[0], "#3fa9f5", "headW");
  draw(results.b?.res?.lines[0]?.pv[0], "#f5793f", "headB");
}

// ---------- editing ----------
const palette = $("palette");
function buildPalette() {
  const pieces = ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p", ""];
  palette.innerHTML = "";
  for (const p of pieces) {
    const b = document.createElement("button");
    b.className = "pal";
    if (p) b.innerHTML = `<span class="pc ${pieceClass(p)}"></span>`;
    else b.textContent = "✕";
    b.title = p ? p : "Empty";
    b.addEventListener("click", () => {
      if (!selected) return;
      grid[selected[0]][selected[1]] = p;
      if (unsure) unsure[selected[0]][selected[1]] = false;
      selected = null;
      palette.hidden = true;
      positionChanged(false, true);
    });
    palette.appendChild(b);
  }
}

function onSquare(r: number, c: number) {
  if (selected && selected[0] === r && selected[1] === c) {
    selected = null;
    palette.hidden = true;
  } else {
    selected = [r, c];
    palette.hidden = false;
  }
  renderBoard();
}

function castling(): Castling {
  return {
    K: $<HTMLInputElement>("cK").checked,
    Q: $<HTMLInputElement>("cQ").checked,
    k: $<HTMLInputElement>("ck").checked,
    q: $<HTMLInputElement>("cq").checked,
  };
}

function syncCastling(resetToPossible: boolean) {
  const pos = possibleCastling(grid);
  for (const k of ["K", "Q", "k", "q"] as const) {
    const box = $<HTMLInputElement>(`c${k}`);
    box.disabled = !pos[k];
    if (resetToPossible) box.checked = pos[k];
    else if (!pos[k]) box.checked = false;
  }
}

/** Call after the pieces change. `keepUnsure` keeps the scanner's red outlines. */
function positionChanged(resetCastling: boolean, keepUnsure = false) {
  if (!keepUnsure) unsure = null;
  syncCastling(resetCastling);
  results = {};
  store.set("position", toFen(grid, "w", castling()).split(" ")[0]);
  $<HTMLInputElement>("fenInput").value = toFen(grid, turn, castling());
  renderBoard();
  renderResults();
}

// ---------- analysis ----------
function formatScore(cp?: number, mate?: number): string {
  if (mate !== undefined) return mate === 0 ? "#" : `${mate > 0 ? "" : "-"}M${Math.abs(mate)}`;
  const v = (cp ?? 0) / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

/** Score of a line from White's point of view. */
function whiteScore(side: Side, cp?: number, mate?: number) {
  const s = side === "w" ? 1 : -1;
  return { cp: cp !== undefined ? cp * s : undefined, mate: mate !== undefined ? mate * s : undefined };
}

function winPercent(cp?: number, mate?: number) {
  if (mate !== undefined) return mate > 0 ? 100 : mate < 0 ? 0 : 50;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * (cp ?? 0))) - 1);
}

function verdictText(cp?: number, mate?: number): string {
  if (mate !== undefined) {
    if (mate === 0) return "Checkmate";
    return `${mate > 0 ? "White" : "Black"} has a forced mate in ${Math.abs(mate)}`;
  }
  const v = cp ?? 0;
  const who = v > 0 ? "White" : "Black";
  const a = Math.abs(v);
  if (a < 35) return "The position is roughly equal";
  if (a < 100) return `${who} is slightly better`;
  if (a < 250) return `${who} is clearly better`;
  if (a < 600) return `${who} has a winning advantage`;
  return `${who} is completely winning`;
}

function renderSide(side: Side) {
  const best = $(side === "w" ? "whiteBest" : "blackBest");
  const alts = $(side === "w" ? "whiteAlts" : "blackAlts");
  const card = $(side === "w" ? "whiteCard" : "blackCard");
  const entry = results[side];
  alts.innerHTML = "";
  card.classList.toggle("dim", side !== turn);
  if (!entry) {
    best.textContent = "—";
    return;
  }
  if (entry.error) {
    best.innerHTML = `<span class="err">${entry.error}</span>`;
    return;
  }
  const lines = entry.res?.lines ?? [];
  if (!lines.length) {
    const st = gameStatus(entry.fen);
    best.textContent = st === "checkmate" ? "Checkmated" : st === "stalemate" ? "Stalemate" : "Thinking…";
    return;
  }
  lines.forEach((l, i) => {
    const san = pvToSan(entry.fen, l.pv);
    const ws = whiteScore(side, l.cp, l.mate);
    const score = formatScore(ws.cp, ws.mate);
    if (i === 0) {
      best.innerHTML = `<span class="mv">${san[0] ?? "?"}</span><span class="score">${score}</span>
        <div class="line">${san.slice(1).join(" ")}</div>
        <div class="depth">depth ${l.depth}</div>`;
    } else {
      const li = document.createElement("li");
      li.innerHTML = `<b>${san[0] ?? "?"}</b> <span class="score">${score}</span>`;
      alts.appendChild(li);
    }
  });
}

function renderEval() {
  const entry = results[turn];
  const fill = $("evalFill");
  const label = $("evalLabel");
  const verdict = $("verdict");
  const top = entry?.res?.lines[0];
  if (!top) {
    fill.style.height = "50%";
    label.textContent = "0.0";
    const st = entry && !entry.error ? gameStatus(entry.fen) : null;
    if (st) {
      verdict.hidden = false;
      verdict.textContent =
        st === "checkmate" ? `Checkmate — ${turn === "w" ? "Black" : "White"} wins` : "Stalemate — draw";
      fill.style.height = st === "checkmate" ? (turn === "w" ? "0%" : "100%") : "50%";
    } else {
      verdict.hidden = true;
    }
    return;
  }
  const ws = whiteScore(turn, top.cp, top.mate);
  const pct = winPercent(ws.cp, ws.mate);
  fill.style.height = `${pct}%`;
  label.textContent = formatScore(ws.cp, ws.mate);
  label.classList.toggle("on-white", pct >= 50);
  verdict.hidden = false;
  verdict.innerHTML = `<b>${verdictText(ws.cp, ws.mate)}</b><span>${Math.round(pct)}% White · ${Math.round(100 - pct)}% Black</span>`;
}

function renderResults() {
  renderSide("w");
  renderSide("b");
  renderEval();
  renderArrows();
}

async function analyse() {
  if (analysing) return;
  selected = null;
  palette.hidden = true;
  analysing = true;
  const btn = $<HTMLButtonElement>("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analyzing…";
  const status = $("engineStatus");
  results = {};
  try {
    const eng = getEngine();
    status.textContent = "Loading engine…";
    await eng.whenReady();
    // Analyse the side whose turn it is first, then the other.
    const order: Side[] = turn === "w" ? ["w", "b"] : ["b", "w"];
    const c = castling();
    for (const side of order) {
      const fen = toFen(grid, side, c);
      const err = checkPosition(grid, side, c);
      results[side] = err ? { fen, error: err } : { fen };
    }
    renderResults();
    for (const side of order) {
      const entry = results[side]!;
      if (entry.error || gameStatus(entry.fen)) continue;
      status.textContent = `Stockfish is thinking about ${side === "w" ? "White" : "Black"}'s move…`;
      entry.res = await eng.analyse(entry.fen, movetime, (r) => {
        entry.res = r;
        renderResults();
      });
      renderResults();
    }
    status.textContent = "Engine: Stockfish 19 (running on your device).";
  } catch (e) {
    status.textContent = `Engine error: ${(e as Error).message}`;
  } finally {
    analysing = false;
    btn.disabled = false;
    btn.textContent = "♟ Analyze position";
  }
}

// ---------- scanning ----------
function showScanStatus(html: string, kind: "info" | "error" | "ok" = "info") {
  const el = $("scanStatus");
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = html;
}

type Pt = [number, number];
let photo: LoadedImage | null = null;
let corners: Pt[] = [];
const overlay = $("overlay") as unknown as SVGSVGElement;
const SVGNS = "http://www.w3.org/2000/svg";

async function onPhoto(file: File | undefined) {
  if (!file) return;
  try {
    photo = await loadImage(file);
  } catch {
    showScanStatus("Couldn't open that image.", "error");
    return;
  }
  const { width: W, height: H } = photo;
  // Start from the corners used last time (same setup is common), else a centred square.
  let saved: Pt[] | null = null;
  try {
    saved = JSON.parse(store.get("corners") ?? "null");
  } catch {
    /* ignore */
  }
  if (saved?.length === 4) corners = saved.map(([x, y]) => [x * W, y * H] as Pt);
  else {
    const s = Math.min(W, H) * 0.7;
    const x0 = (W - s) / 2,
      y0 = (H - s) / 2;
    corners = [
      [x0, y0],
      [x0 + s, y0],
      [x0 + s, y0 + s],
      [x0, y0 + s],
    ];
  }
  $<HTMLImageElement>("preview").src = photo.url;
  overlay.setAttribute("viewBox", `0 0 ${W} ${H}`);
  $("cornerStep").hidden = false;
  $("scanStatus").hidden = true;
  drawOverlay();
  $("cornerStep").scrollIntoView({ behavior: "smooth", block: "start" });
  loadModels().catch(() => undefined); // warm up while the user aligns the corners
}

function drawOverlay() {
  if (!photo) return;
  overlay.innerHTML = "";
  const size = Math.max(photo.width, photo.height);
  const ordered = orderCorners(corners);
  const Hm = perspective(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    ordered,
  );
  const mk = (tag: string, attrs: Record<string, string | number>) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    overlay.appendChild(el);
    return el;
  };
  const sw = size * 0.003;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const outer = i === 0 || i === 8;
    for (const [a, b] of [
      [apply(Hm, t, 0), apply(Hm, t, 1)],
      [apply(Hm, 0, t), apply(Hm, 1, t)],
    ])
      mk("line", {
        x1: a[0],
        y1: a[1],
        x2: b[0],
        y2: b[1],
        stroke: outer ? "#6cc04a" : "rgba(108,192,74,.75)",
        "stroke-width": outer ? sw * 2 : sw,
      });
  }
  // Mark the side nearest the camera (bottom of the photo) is where the model expects to look from.
  corners.forEach(([x, y]) => {
    mk("circle", { cx: x, cy: y, r: size * 0.035, fill: "rgba(108,192,74,.25)", stroke: "#6cc04a", "stroke-width": sw * 2 });
    mk("circle", { cx: x, cy: y, r: size * 0.005, fill: "#fff" });
  });
}

// Dragging the corner handles (with a magnifier so the finger doesn't hide the corner).
let drag: { i: number; dx: number; dy: number } | null = null;
const loupe = $("loupe");
const loupeCtx = loupe.querySelector("canvas")!.getContext("2d")!;

function toImage(e: PointerEvent): Pt {
  const r = overlay.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * photo!.width, ((e.clientY - r.top) / r.height) * photo!.height];
}

function showLoupe(p: Pt) {
  const img = $<HTMLImageElement>("preview");
  const zoom = 70 * (photo!.width / overlay.getBoundingClientRect().width) * 0.5;
  loupeCtx.fillStyle = "#000";
  loupeCtx.fillRect(0, 0, 140, 140);
  loupeCtx.drawImage(img, p[0] - zoom / 2, p[1] - zoom / 2, zoom, zoom, 0, 0, 140, 140);
  loupeCtx.strokeStyle = "#6cc04a";
  loupeCtx.lineWidth = 1.5;
  loupeCtx.beginPath();
  loupeCtx.moveTo(70, 50);
  loupeCtx.lineTo(70, 90);
  loupeCtx.moveTo(50, 70);
  loupeCtx.lineTo(90, 70);
  loupeCtx.stroke();
  loupe.hidden = false;
  // Put the loupe in the corner away from the finger.
  const r = overlay.getBoundingClientRect();
  const left = p[0] / photo!.width < 0.5;
  loupe.style.left = left ? "" : "8px";
  loupe.style.right = left ? "8px" : "";
  loupe.style.top = `${$("photoWrap").offsetTop + 8 + (p[1] / photo!.height < 0.3 ? r.height - 156 : 0)}px`;
}

overlay.addEventListener("pointerdown", (e) => {
  if (!photo) return;
  const p = toImage(e);
  let best = -1,
    bestD = Math.max(photo.width, photo.height) * 0.15;
  corners.forEach(([x, y], i) => {
    const d = Math.hypot(x - p[0], y - p[1]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0) return;
  drag = { i: best, dx: corners[best][0] - p[0], dy: corners[best][1] - p[1] };
  overlay.setPointerCapture(e.pointerId);
  showLoupe(corners[best]);
  e.preventDefault();
});
overlay.addEventListener("pointermove", (e) => {
  if (!drag || !photo) return;
  const p = toImage(e);
  const x = Math.min(photo.width, Math.max(0, p[0] + drag.dx));
  const y = Math.min(photo.height, Math.max(0, p[1] + drag.dy));
  corners[drag.i] = [x, y];
  drawOverlay();
  showLoupe([x, y]);
});
const endDrag = () => {
  drag = null;
  loupe.hidden = true;
};
overlay.addEventListener("pointerup", endDrag);
overlay.addEventListener("pointercancel", endDrag);

async function readBoard() {
  if (!photo) return;
  const btn = $<HTMLButtonElement>("readBtn");
  btn.disabled = true;
  showScanStatus(`<span class="spinner"></span> Reading the board…`);
  try {
    store.set("corners", JSON.stringify(corners.map(([x, y]) => [x / photo!.width, y / photo!.height])));
    const guesses = await classifySquares(photo.data, corners);
    const reading = decide(guesses, guessWhiteSide(guesses));
    grid = reading.grid;
    unsure = reading.uncertain;
    flipped = false;
    positionChanged(true, true);
    const nUnsure = unsure.flat().filter(Boolean).length;
    const warn = checkPosition(grid, "w", castling()) && checkPosition(grid, "b", castling());
    showScanStatus(
      `✓ Board read. Compare it with your board and tap any wrong square to fix it.` +
        (nUnsure ? ` <b>${nUnsure}</b> square${nUnsure > 1 ? "s" : ""} marked in red need a check.` : "") +
        ` If the pieces look turned, use <b>Rotate pieces 90°</b>.` +
        (warn ? `<br><b>Check:</b> ${escapeHtml(warn)}` : ""),
      warn ? "error" : "ok",
    );
    $("positionCard").scrollIntoView({ behavior: "smooth", block: "start" });
    if (!warn) analyse();
  } catch (e) {
    showScanStatus(`Couldn't read the board: ${escapeHtml((e as Error).message)}`, "error");
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// ---------- wiring ----------
$<HTMLInputElement>("cameraInput").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  onPhoto(input.files?.[0]);
  input.value = "";
});
$<HTMLInputElement>("galleryInput").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  onPhoto(input.files?.[0]);
  input.value = "";
});
$("readBtn").addEventListener("click", readBoard);
$("flipBtn").addEventListener("click", () => {
  flipped = !flipped;
  renderBoard();
});
$("rotateBtn").addEventListener("click", () => {
  grid = rotateGrid(grid);
  positionChanged(true);
});
$("startBtn").addEventListener("click", () => {
  grid = placementToGrid(START_FEN.split(" ")[0]);
  positionChanged(true);
});
$("clearBtn").addEventListener("click", () => {
  grid = emptyGrid();
  positionChanged(true);
});
for (const k of ["K", "Q", "k", "q"]) {
  $(`c${k}`).addEventListener("change", () => {
    results = {};
    $<HTMLInputElement>("fenInput").value = toFen(grid, turn, castling());
    renderResults();
  });
}
$("fenLoad").addEventListener("click", () => {
  const fen = $<HTMLInputElement>("fenInput").value.trim();
  const [placement, side, cs = "-"] = fen.split(/\s+/);
  if (!placement || placement.split("/").length !== 8) return;
  grid = placementToGrid(placement);
  if (side === "w" || side === "b") setTurn(side);
  syncCastling(false);
  for (const k of ["K", "Q", "k", "q"]) $<HTMLInputElement>(`c${k}`).checked = cs.includes(k);
  positionChanged(false);
});

function setTurn(t: Side) {
  turn = t;
  document.querySelectorAll<HTMLButtonElement>("[data-turn]").forEach((b) => b.classList.toggle("active", b.dataset.turn === t));
  $<HTMLInputElement>("fenInput").value = toFen(grid, turn, castling());
  renderResults();
}
document.querySelectorAll<HTMLButtonElement>("[data-turn]").forEach((b) =>
  b.addEventListener("click", () => setTurn(b.dataset.turn as Side)),
);
document.querySelectorAll<HTMLButtonElement>("[data-time]").forEach((b) =>
  b.addEventListener("click", () => {
    movetime = Number(b.dataset.time);
    document.querySelectorAll<HTMLButtonElement>("[data-time]").forEach((x) => x.classList.toggle("active", x === b));
  }),
);
$("analyzeBtn").addEventListener("click", analyse);

buildPalette();
positionChanged(true);
