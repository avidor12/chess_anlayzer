import "./style.css";
import "./pieces.css";
import { detectBoard } from "./detect";
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
  fromSource,
  guessWhiteSide,
  loadImage,
  loadModels,
  orderCorners,
  perspective,
  type LoadedImage,
} from "./vision";

type Pt = [number, number];

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
const FILES = "abcdefgh";
const SVGNS = "http://www.w3.org/2000/svg";
/** CSS class for a FEN piece char, e.g. "N" -> "wN", "q" -> "bQ". */
const pieceClass = (p: string) => (p === p.toUpperCase() ? "w" : "b") + p.toUpperCase();
const PIECE_NAMES: Record<string, string> = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

let toastTimer = 0;
function toast(msg: string, ms = 2800) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

function busy(text: string | null) {
  $("busy").hidden = text === null;
  if (text) $("busyText").textContent = text;
}

// ---------- state ----------
let grid: Grid = placementToGrid(START_FEN.split(" ")[0]);
let flipped = false;
let selected: [number, number] | null = null;
let turn: Side = "w";
let movetime = Number(store.get("movetime")) || 3000;
let unsure: boolean[][] | null = null;
let photo: LoadedImage | null = null;
let corners: Pt[] = [];

type Entry = { fen: string; res?: SearchResult; error?: string };
let results: Partial<Record<Side, Entry>> = {};

let engine: Engine | null = null;
function getEngine() {
  engine ??= new Engine(`${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`);
  return engine;
}

function showResult() {
  $("home").hidden = true;
  $("result").hidden = false;
  $("bottomBar").hidden = false;
}

// ---------- board ----------
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
      const p = grid[r][c];
      sq.setAttribute("aria-label", `${FILES[c]}${8 - r}${p ? " " + PIECE_NAMES[p.toLowerCase()] : ""}`);
      if (p) {
        const span = document.createElement("span");
        span.className = `pc ${pieceClass(p)}`;
        sq.appendChild(span);
      }
      if (vc === 0) sq.insertAdjacentHTML("beforeend", `<i class="coord rank">${8 - r}</i>`);
      if (vr === 7) sq.insertAdjacentHTML("beforeend", `<i class="coord file">${FILES[c]}</i>`);
      sq.addEventListener("click", () => openPicker(r, c));
      boardEl.appendChild(sq);
    }
  }
  renderArrows();
  const n = unsure?.flat().filter(Boolean).length ?? 0;
  const hint = $("boardHint");
  hint.classList.toggle("warn", n > 0);
  hint.textContent = n
    ? `Check the ${n} dashed square${n > 1 ? "s" : ""} — tap any square to fix it.`
    : "Tap any square to fix it.";
}

function squareCenter(sq: string): Pt {
  const c = FILES.indexOf(sq[0]);
  const r = 8 - Number(sq[1]);
  const vc = flipped ? 7 - c : c;
  const vr = flipped ? 7 - r : r;
  return [vc * 100 + 50, vr * 100 + 50];
}

function renderArrows() {
  arrowsEl.querySelectorAll("line").forEach((l) => l.remove());
  const draw = (uci: string | undefined, color: string, marker: string, strong: boolean) => {
    if (!uci) return;
    const [x1, y1] = squareCenter(uci.slice(0, 2));
    const [x2, y2] = squareCenter(uci.slice(2, 4));
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ex = x2 - ((x2 - x1) / len) * 30;
    const ey = y2 - ((y2 - y1) / len) * 30;
    const line = document.createElementNS(SVGNS, "line");
    Object.entries({
      x1, y1, x2: ex, y2: ey, stroke: color,
      "stroke-width": strong ? 18 : 13,
      "stroke-linecap": "round",
      opacity: strong ? 0.9 : 0.55,
      "marker-end": `url(#${marker})`,
    }).forEach(([k, v]) => line.setAttribute(k, String(v)));
    arrowsEl.appendChild(line);
  };
  // The side to move gets the bold arrow; draw it last so it is on top.
  const other: Side = turn === "w" ? "b" : "w";
  for (const side of [other, turn]) {
    draw(results[side]?.res?.lines[0]?.pv[0], side === "w" ? "#3fa9f5" : "#f5793f", side === "w" ? "headW" : "headB", side === turn);
  }
}

// ---------- piece picker ----------
function openPicker(r: number, c: number) {
  selected = [r, c];
  renderBoard();
  $("sheetTitle").textContent = `Square ${FILES[c]}${8 - r}`;
  const pal = $("palette");
  pal.innerHTML = "";
  const pieces = ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"];
  for (const p of pieces) {
    const b = document.createElement("button");
    b.className = `pal ${p === p.toLowerCase() ? "dark" : ""}`;
    b.innerHTML = `<span class="pc ${pieceClass(p)}"></span>`;
    b.setAttribute("aria-label", `${p === p.toUpperCase() ? "White" : "Black"} ${PIECE_NAMES[p.toLowerCase()]}`);
    b.addEventListener("click", () => setSquare(p));
    pal.appendChild(b);
  }
  const empty = document.createElement("button");
  empty.className = "pal empty";
  empty.textContent = "Empty square";
  empty.addEventListener("click", () => setSquare(""));
  pal.appendChild(empty);
  $("sheet").hidden = false;
  $("sheetBackdrop").hidden = false;
}

function closeSheets() {
  $("sheet").hidden = true;
  $("moreSheet").hidden = true;
  $("sheetBackdrop").hidden = true;
  if (selected) {
    selected = null;
    renderBoard();
  }
}

function setSquare(p: string) {
  if (!selected) return;
  const [r, c] = selected;
  grid[r][c] = p;
  if (unsure) unsure[r][c] = false;
  closeSheets();
  positionChanged(false, true);
}

// ---------- position ----------
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

/** Call after the pieces change; re-analyses automatically. */
function positionChanged(resetCastling: boolean, keepUnsure = false) {
  if (!keepUnsure) unsure = null;
  syncCastling(resetCastling);
  store.set("position", toFen(grid, "w", castling()).split(" ")[0]);
  $<HTMLInputElement>("fenInput").value = toFen(grid, turn, castling());
  renderBoard();
  analyse();
}

// ---------- analysis ----------
function formatScore(cp?: number, mate?: number): string {
  if (mate !== undefined) return mate === 0 ? "#" : `${mate > 0 ? "+" : "-"}M${Math.abs(mate)}`;
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
    return `${mate > 0 ? "White" : "Black"} mates in ${Math.abs(mate)}`;
  }
  const v = cp ?? 0;
  const who = v > 0 ? "White" : "Black";
  const a = Math.abs(v);
  if (a < 35) return "Equal position";
  if (a < 100) return `${who} is slightly better`;
  if (a < 250) return `${who} is better`;
  if (a < 600) return `${who} is winning`;
  return `${who} is completely winning`;
}

function renderSide(side: Side) {
  const best = $(side === "w" ? "whiteBest" : "blackBest");
  const alts = $(side === "w" ? "whiteAlts" : "blackAlts");
  $(side === "w" ? "whiteCard" : "blackCard").classList.toggle("dim", side !== turn);
  alts.innerHTML = "";
  const entry = results[side];
  if (!entry) {
    best.innerHTML = `<span class="placeholder">…</span>`;
    return;
  }
  if (entry.error) {
    best.innerHTML = `<span class="err">${escapeHtml(entry.error)}</span>`;
    return;
  }
  const lines = entry.res?.lines ?? [];
  if (!lines.length) {
    const st = gameStatus(entry.fen);
    best.innerHTML = `<span class="placeholder">${st === "checkmate" ? "Checkmated" : st === "stalemate" ? "Stalemate" : "Thinking…"}</span>`;
    return;
  }
  lines.forEach((l, i) => {
    const san = pvToSan(entry.fen, l.pv);
    const ws = whiteScore(side, l.cp, l.mate);
    const score = formatScore(ws.cp, ws.mate);
    if (i === 0) {
      best.innerHTML = `<span class="mv">${san[0] ?? "?"}</span><span class="score">${score}</span>
        <div class="line">${san.slice(1, 5).join(" ")}</div>`;
    } else {
      const li = document.createElement("li");
      li.innerHTML = `<b>${san[0] ?? "?"}</b> <span class="score">${score}</span>`;
      alts.appendChild(li);
    }
  });
}

function setBar(pct: number, label: string, verdict: string) {
  $("hbarFill").style.width = `${pct}%`;
  $("pctW").textContent = `${Math.round(pct)}%`;
  $("pctB").textContent = `${Math.round(100 - pct)}%`;
  $("evalNum").textContent = label;
  $("verdict").textContent = verdict;
}

function renderEval() {
  const entry = results[turn];
  const top = entry?.res?.lines[0];
  if (top) {
    const ws = whiteScore(turn, top.cp, top.mate);
    setBar(winPercent(ws.cp, ws.mate), formatScore(ws.cp, ws.mate), verdictText(ws.cp, ws.mate));
    return;
  }
  if (entry && !entry.error) {
    const st = gameStatus(entry.fen);
    if (st === "checkmate") return setBar(turn === "w" ? 0 : 100, "#", `Checkmate — ${turn === "w" ? "Black" : "White"} wins`);
    if (st === "stalemate") return setBar(50, "½", "Stalemate — draw");
  }
  if (entry?.error) return setBar(50, "–", "Not a legal position");
  setBar(50, "…", "Analyzing…");
}

function renderResults() {
  renderSide("w");
  renderSide("b");
  renderEval();
  renderArrows();
}

let analysisToken = 0;
async function analyse() {
  const token = ++analysisToken;
  const eng = getEngine();
  eng.stop();
  const c = castling();
  results = {};
  for (const side of ["w", "b"] as Side[]) {
    const fen = toFen(grid, side, c);
    const err = checkPosition(grid, side, c);
    results[side] = err ? { fen, error: err } : { fen };
  }
  // If only one side can be to move (the other king is in check), switch to it.
  const other: Side = turn === "w" ? "b" : "w";
  if (results[turn]?.error && !results[other]?.error) {
    setTurn(other);
    toast(`${other === "w" ? "White" : "Black"} to move — the other king is in check.`);
  }
  const order: Side[] = turn === "w" ? ["w", "b"] : ["b", "w"];
  renderResults();
  $("thinking").hidden = false;
  try {
    await eng.whenReady();
    for (const side of order) {
      if (token !== analysisToken) return;
      const entry = results[side]!;
      if (entry.error || gameStatus(entry.fen)) continue;
      const res = await eng.analyse(entry.fen, movetime, (r) => {
        if (token !== analysisToken) return;
        entry.res = r;
        renderResults();
      });
      if (token !== analysisToken) return;
      entry.res = res;
      renderResults();
    }
  } catch (e) {
    toast(`Engine error: ${(e as Error).message}`);
  } finally {
    if (token === analysisToken) $("thinking").hidden = true;
  }
}

function setTurn(t: Side) {
  if (t === turn) return;
  turn = t;
  document.querySelectorAll<HTMLButtonElement>("[data-turn]").forEach((b) => b.classList.toggle("active", b.dataset.turn === t));
  $<HTMLInputElement>("fenInput").value = toFen(grid, turn, castling());
  renderResults();
}

// ---------- scanning pipeline ----------
async function processPhoto(img: LoadedImage) {
  photo = img;
  busy("Finding the board…");
  await nextFrame();
  const found = detectBoard(img.data);
  if (!found) {
    busy(null);
    corners = defaultCorners();
    openAdjust("I couldn't find the board by myself. Drag the 4 circles onto its corners.", true);
    return;
  }
  corners = found.corners;
  await readBoard(found.score < 0.5);
}

async function readBoard(lowConfidence = false) {
  if (!photo) return;
  busy("Reading the pieces…");
  await nextFrame();
  try {
    const guesses = await classifySquares(photo.data, corners);
    const reading = decide(guesses, guessWhiteSide(guesses));
    grid = reading.grid;
    unsure = reading.uncertain;
    flipped = false;
    closeAdjust();
    showResult();
    renderThumb();
    const n = unsure.flat().filter(Boolean).length;
    const pieces = grid.flat().filter(Boolean).length;
    $("scanNote").innerHTML =
      `Found <b>${pieces}</b> piece${pieces === 1 ? "" : "s"}.` +
      (lowConfidence ? " The board outline may be off." : "") +
      (n ? ` <b>${n}</b> square${n > 1 ? "s" : ""} to check.` : "");
    positionChanged(true, true);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (pieces === 0) toast("No pieces found — is the board outline right?");
  } catch (e) {
    toast(`Couldn't read the board: ${(e as Error).message}`, 5000);
  } finally {
    busy(null);
  }
}

function defaultCorners(): Pt[] {
  const { width: W, height: H } = photo!;
  const s = Math.min(W, H) * 0.8;
  const x0 = (W - s) / 2,
    y0 = (H - s) / 2;
  return [
    [x0, y0],
    [x0 + s, y0],
    [x0 + s, y0 + s],
    [x0, y0 + s],
  ];
}

/** Draw the 8x8 grid for the given corners into an SVG sized to the photo. */
function drawGrid(svg: SVGSVGElement, withHandles: boolean) {
  if (!photo) return;
  svg.setAttribute("viewBox", `0 0 ${photo.width} ${photo.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = "";
  const size = Math.max(photo.width, photo.height);
  const Hm = perspective([[0, 0], [1, 0], [1, 1], [0, 1]], orderCorners(corners));
  const mk = (tag: string, attrs: Record<string, string | number>) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  };
  const sw = size * (withHandles ? 0.0025 : 0.005);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const outer = i === 0 || i === 8;
    for (const [a, b] of [
      [apply(Hm, t, 0), apply(Hm, t, 1)],
      [apply(Hm, 0, t), apply(Hm, 1, t)],
    ])
      mk("line", {
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke: outer ? "#7bd35a" : "rgba(123,211,90,.7)",
        "stroke-width": outer ? sw * 2 : sw,
      });
  }
  if (withHandles)
    corners.forEach(([x, y]) => {
      mk("circle", { cx: x, cy: y, r: size * 0.04, fill: "rgba(123,211,90,.22)", stroke: "#7bd35a", "stroke-width": sw * 2.5 });
      mk("circle", { cx: x, cy: y, r: size * 0.006, fill: "#fff" });
    });
}

function renderThumb() {
  if (!photo) return;
  $("scanCard").hidden = false;
  $<HTMLImageElement>("thumb").src = photo.url;
  drawGrid($("thumbGrid") as unknown as SVGSVGElement, false);
}

// ---------- adjust screen ----------
const overlay = $("overlay") as unknown as SVGSVGElement;

function openAdjust(msg?: string, warn = false) {
  if (!photo) return;
  $<HTMLImageElement>("photo").src = photo.url;
  const m = $("adjustMsg");
  m.textContent = msg ?? "Drag the 4 circles onto the corners of the squares (not the outer frame).";
  m.classList.toggle("warn", warn);
  $("adjust").hidden = false;
  drawGrid(overlay, true);
  loadModels().catch(() => undefined);
}
function closeAdjust() {
  $("adjust").hidden = true;
  $("loupe").hidden = true;
}

let drag: { i: number; dx: number; dy: number } | null = null;
const loupe = $("loupe");
const loupeCtx = loupe.querySelector("canvas")!.getContext("2d")!;

function toImage(e: PointerEvent): Pt {
  const r = overlay.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * photo!.width, ((e.clientY - r.top) / r.height) * photo!.height];
}

function showLoupe(p: Pt) {
  const img = $<HTMLImageElement>("photo");
  const shown = overlay.getBoundingClientRect().width;
  const span = (60 * photo!.width) / shown; // image px visible in the loupe (~2.7x zoom)
  loupeCtx.fillStyle = "#000";
  loupeCtx.fillRect(0, 0, 160, 160);
  loupeCtx.drawImage(img, p[0] - span / 2, p[1] - span / 2, span, span, 0, 0, 160, 160);
  loupeCtx.strokeStyle = "#7bd35a";
  loupeCtx.lineWidth = 2;
  loupeCtx.beginPath();
  loupeCtx.moveTo(80, 58);
  loupeCtx.lineTo(80, 102);
  loupeCtx.moveTo(58, 80);
  loupeCtx.lineTo(102, 80);
  loupeCtx.stroke();
  loupe.hidden = false;
  const onLeft = p[0] / photo!.width < 0.5;
  loupe.classList.toggle("right", onLeft);
  loupe.classList.toggle("left", !onLeft);
}

overlay.addEventListener("pointerdown", (e) => {
  if (!photo) return;
  const p = toImage(e);
  let best = -1,
    bestD = Math.max(photo.width, photo.height) * 0.18;
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
  drawGrid(overlay, true);
  showLoupe([x, y]);
});
const endDrag = () => {
  drag = null;
  loupe.hidden = true;
};
overlay.addEventListener("pointerup", endDrag);
overlay.addEventListener("pointercancel", endDrag);

// ---------- camera ----------
let stream: MediaStream | null = null;
const video = $<HTMLVideoElement>("video");

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $("fileCamera").click();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
  } catch {
    // Permission denied or no camera: use the phone's own camera app instead.
    $("fileCamera").click();
    return;
  }
  video.srcObject = stream;
  $("camera").hidden = false;
  await video.play().catch(() => undefined);
  loadModels().catch(() => undefined); // warm up while the user frames the board
  getEngine();
}

function closeCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $("camera").hidden = true;
}

async function capture() {
  const w = video.videoWidth,
    h = video.videoHeight;
  if (!w || !h) return;
  const img = fromSource(video, w, h);
  closeCamera();
  await processPhoto(img);
}

async function onFile(file: File | undefined) {
  if (!file) return;
  busy("Opening photo…");
  try {
    const img = await loadImage(file);
    await processPhoto(img);
  } catch (e) {
    busy(null);
    toast((e as Error).message || "Couldn't open that image.", 4000);
  }
}

// ---------- wiring ----------
$("scanBtn").addEventListener("click", openCamera);
$("newScanBtn").addEventListener("click", openCamera);
$("uploadBtn").addEventListener("click", () => $("fileGallery").click());
$("newUploadBtn").addEventListener("click", () => $("fileGallery").click());
$("camGallery").addEventListener("click", () => {
  closeCamera();
  $("fileGallery").click();
});
$("camClose").addEventListener("click", closeCamera);
$("shutter").addEventListener("click", capture);
for (const id of ["fileCamera", "fileGallery"]) {
  $<HTMLInputElement>(id).addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    onFile(f);
  });
}
$("manualBtn").addEventListener("click", () => {
  showResult();
  positionChanged(true);
  toast("Tap squares to place pieces, or use ⚙︎ More → Empty board.");
});

$("adjCancel").addEventListener("click", closeAdjust);
$("adjDone").addEventListener("click", () => readBoard());
$("adjRead").addEventListener("click", () => readBoard());
$("adjustBtn").addEventListener("click", () => openAdjust());
$("thumbWrap").addEventListener("click", () => openAdjust());

$("flipBtn").addEventListener("click", () => {
  flipped = !flipped;
  renderBoard();
});
$("rotateBtn").addEventListener("click", () => {
  grid = rotateGrid(grid);
  if (unsure) unsure = rotateGrid(unsure.map((r) => r.map((v) => (v ? "x" : "")))).map((r) => r.map((v) => v === "x"));
  positionChanged(true, true);
});
$("moreBtn").addEventListener("click", () => {
  $("moreSheet").hidden = false;
  $("sheetBackdrop").hidden = false;
});
$("sheetBackdrop").addEventListener("click", closeSheets);
$("startBtn").addEventListener("click", () => {
  grid = placementToGrid(START_FEN.split(" ")[0]);
  closeSheets();
  positionChanged(true);
});
$("clearBtn").addEventListener("click", () => {
  grid = emptyGrid();
  closeSheets();
  positionChanged(true);
});
for (const k of ["K", "Q", "k", "q"]) $(`c${k}`).addEventListener("change", () => positionChanged(false, true));
$("fenLoad").addEventListener("click", () => {
  const fen = $<HTMLInputElement>("fenInput").value.trim();
  const [placement, side, cs = "-"] = fen.split(/\s+/);
  if (!placement || placement.split("/").length !== 8) return toast("That doesn't look like a FEN.");
  grid = placementToGrid(placement);
  if (side === "w" || side === "b") setTurn(side);
  syncCastling(false);
  for (const k of ["K", "Q", "k", "q"]) $<HTMLInputElement>(`c${k}`).checked = cs.includes(k);
  closeSheets();
  positionChanged(false);
});
document.querySelectorAll<HTMLButtonElement>("[data-turn]").forEach((b) =>
  b.addEventListener("click", () => setTurn(b.dataset.turn as Side)),
);
document.querySelectorAll<HTMLButtonElement>("[data-time]").forEach((b) => {
  b.classList.toggle("active", Number(b.dataset.time) === movetime);
  b.addEventListener("click", () => {
    movetime = Number(b.dataset.time);
    store.set("movetime", String(movetime));
    document.querySelectorAll<HTMLButtonElement>("[data-time]").forEach((x) => x.classList.toggle("active", x === b));
    analyse();
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSheets();
    if (!$("camera").hidden) closeCamera();
  }
});

// Restore the last position so reopening the app shows where you left off.
const saved = store.get("position");
if (saved) {
  try {
    grid = placementToGrid(saved);
  } catch {
    /* ignore */
  }
}
syncCastling(true);
renderBoard();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
}
