import "./style.css";
import "./pieces.css";
import { Engine, type SearchResult } from "./engine";
import {
  START_FEN,
  checkPosition,
  emptyGrid,
  gameStatus,
  photoGridToBoard,
  placementToGrid,
  possibleCastling,
  pvToSan,
  rotateGrid,
  toFen,
  type Castling,
  type Grid,
  type Side,
} from "./position";
// The vision module (Anthropic SDK) is loaded on demand to keep startup fast.
const vision = () => import("./vision");

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
let lastImage: Awaited<ReturnType<Awaited<ReturnType<typeof vision>>["prepareImage"]>> | null = null;
let recognizeAbort: AbortController | null = null;

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
      selected = null;
      palette.hidden = true;
      positionChanged(false);
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

function positionChanged(resetCastling: boolean) {
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

async function onPhoto(file: File | undefined) {
  if (!file) return;
  try {
    lastImage = await (await vision()).prepareImage(file);
  } catch {
    showScanStatus("Couldn't open that image.", "error");
    return;
  }
  const img = $<HTMLImageElement>("preview");
  img.src = lastImage.url;
  img.hidden = false;
  await recognize();
}

async function recognize() {
  if (!lastImage) return;
  const apiKey = store.get("apiKey");
  if (!apiKey) {
    showScanStatus("Add your Anthropic API key in ⚙︎ Settings to recognize the board automatically — or set up the pieces by hand below.", "error");
    openSettings();
    return;
  }
  recognizeAbort?.abort();
  recognizeAbort = new AbortController();
  $("rescanBtn").hidden = true;
  showScanStatus(`<span class="spinner"></span> Reading the board… this can take up to a minute.`);
  try {
    const { recognizeBoard, rowsToPhotoGrid } = await vision();
    const reading = await recognizeBoard({ apiKey, image: lastImage, signal: recognizeAbort.signal });
    grid = photoGridToBoard(rowsToPhotoGrid(reading.rows), reading.white_side);
    flipped = false;
    positionChanged(true);
    const warn = checkPosition(grid, "w", castling()) && checkPosition(grid, "b", castling());
    const conf = reading.confidence !== "high" ? ` Confidence: <b>${reading.confidence}</b>.` : "";
    const notes = reading.notes ? ` <i>${escapeHtml(reading.notes)}</i>` : "";
    showScanStatus(
      `✓ Board recognized.${conf} Please compare with your board and fix any square by tapping it.${notes}` +
        (warn ? `<br><b>Check:</b> ${escapeHtml(warn)}` : ""),
      warn || reading.confidence === "low" ? "error" : "ok",
    );
    $("positionCard").scrollIntoView({ behavior: "smooth", block: "start" });
    if (!warn) analyse();
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    showScanStatus(`Recognition failed: ${escapeHtml((e as Error).message)}`, "error");
  } finally {
    $("rescanBtn").hidden = false;
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// ---------- settings ----------
const dialog = $<HTMLDialogElement>("settings");
function openSettings() {
  $<HTMLInputElement>("apiKey").value = store.get("apiKey") ?? "";
  dialog.showModal();
}
dialog.addEventListener("close", () => {
  if (dialog.returnValue === "save") {
    store.set("apiKey", $<HTMLInputElement>("apiKey").value.trim());
    if (lastImage && store.get("apiKey")) recognize();
  }
});

// ---------- wiring ----------
$("settingsBtn").addEventListener("click", openSettings);
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
$("rescanBtn").addEventListener("click", recognize);
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
