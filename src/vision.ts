// On-device board recognition from a photo.
//
// Pipeline (after chesscog by Wölflein & Arandjelović, MIT):
//   1. the user marks the four corners of the 8x8 grid,
//   2. each square is cut out of the perspective-corrected board (the piece crop is
//      taller than the square, so it contains the whole piece standing on it),
//   3. two small MobileNetV3 classifiers (cstr/chess-board-photo-onnx, MIT) decide
//      empty/occupied and, for occupied squares, which of the 12 pieces it is.
// Everything runs in the browser with onnxruntime-web — no server, no API key.
import * as ort from "onnxruntime-web/wasm";
import type { Grid, WhiteSide } from "./position";
import { photoGridToBoard } from "./position";

export type Point = [number, number];

const BASE = import.meta.env.BASE_URL;
ort.env.wasm.numThreads = 1;

// ---------- image loading ----------

export interface LoadedImage {
  data: ImageData;
  url: string;
  width: number;
  height: number;
}

/** Load a photo, honouring EXIF orientation, downscaled so the long edge is at most `maxEdge`. */
export async function loadImage(file: Blob, maxEdge = 1600): Promise<LoadedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { data: ctx.getImageData(0, 0, width, height), url: canvas.toDataURL("image/jpeg", 0.9), width, height };
}

// ---------- geometry ----------

export type Mat3 = number[]; // row-major 3x3

/** Homography mapping src[i] -> dst[i] for 4 point pairs. */
export function perspective(src: Point[], dst: Point[]): Mat3 {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export function apply(H: Mat3, x: number, y: number): Point {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Order 4 points as top-left, top-right, bottom-right, bottom-left (as seen in the photo). */
export function orderCorners(pts: Point[]): Point[] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  ); // clockwise in screen coords, starting from the left/top
  // Start from the point with the smallest x+y (top-left).
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

// ---------- cropping (matches chesscog's crop geometry) ----------

const SQ = 50;
const BOARD = 8 * SQ;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Bilinear sample of the source image, writing normalised CHW floats; black outside. */
function sampleInto(
  img: ImageData,
  H: Mat3,
  out: Float32Array,
  offset: number,
  outW: number,
  outH: number,
  warpedXY: (ox: number, oy: number) => Point | null,
) {
  const { data, width, height } = img;
  const plane = outW * outH;
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const w = warpedXY(ox, oy);
      let r = 0,
        g = 0,
        b = 0;
      if (w) {
        const [sx, sy] = apply(H, w[0], w[1]);
        const x0 = Math.floor(sx),
          y0 = Math.floor(sy);
        const fx = sx - x0,
          fy = sy - y0;
        const px = (x: number, y: number, ch: number) =>
          x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 4 + ch];
        for (let ch = 0; ch < 3; ch++) {
          const v =
            px(x0, y0, ch) * (1 - fx) * (1 - fy) +
            px(x0 + 1, y0, ch) * fx * (1 - fy) +
            px(x0, y0 + 1, ch) * (1 - fx) * fy +
            px(x0 + 1, y0 + 1, ch) * fx * fy;
          if (ch === 0) r = v;
          else if (ch === 1) g = v;
          else b = v;
        }
      }
      const i = oy * outW + ox;
      out[offset + i] = (r / 255 - MEAN[0]) / STD[0];
      out[offset + plane + i] = (g / 255 - MEAN[1]) / STD[1];
      out[offset + 2 * plane + i] = (b / 255 - MEAN[2]) / STD[2];
    }
  }
}

function buildInputs(img: ImageData, corners: Point[]) {
  const c = orderCorners(corners);
  // Warped board coordinates: board occupies [0, 400]^2. Map warped -> photo.
  const H = perspective(
    [
      [0, 0],
      [BOARD, 0],
      [BOARD, BOARD],
      [0, BOARD],
    ],
    c,
  );
  const occ = new Float32Array(64 * 3 * 100 * 100);
  const pcs = new Float32Array(64 * 3 * 200 * 100);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const i = row * 8 + col;
      // Occupancy crop: the square plus half a square around it, 100x100.
      const ox0 = Math.trunc(SQ * (col + 0.5)) - SQ;
      const oy0 = Math.trunc(SQ * (row + 0.5)) - SQ;
      sampleInto(img, H, occ, i * 30000, 100, 100, (x, y) => [ox0 + x, oy0 + y]);

      // Piece crop: taller for rows further from the camera, wider towards the edges,
      // mirrored on the left half, pasted bottom-left into a black 100x200 canvas.
      const MARGIN = BOARD / 2;
      const hi = 1 + 2 * ((7 - row) / 7);
      const li = col >= 4 ? 0 : 0.25 + 0.75 * ((3 - col) / 3);
      const ri = col < 4 ? 0 : 0.25 + 0.75 * ((col - 4) / 3);
      const x1 = Math.trunc(MARGIN + SQ * (col - li));
      const x2 = Math.trunc(MARGIN + SQ * (col + 1 + ri));
      const y1 = Math.trunc(MARGIN + SQ * (row - hi));
      const y2 = Math.trunc(MARGIN + SQ * (row + 1));
      const w = x2 - x1;
      const h = y2 - y1;
      const flip = col < 4;
      sampleInto(img, H, pcs, i * 60000, 100, 200, (x, y) => {
        if (x >= w || y < 200 - h) return null;
        const cx = flip ? w - 1 - x : x;
        const cy = y - (200 - h);
        return [x1 + cx - MARGIN, y1 + cy - MARGIN];
      });
    }
  }
  return { occ, pcs };
}

// ---------- models ----------

let sessions: Promise<[ort.InferenceSession, ort.InferenceSession]> | null = null;
export function loadModels() {
  sessions ??= Promise.all([
    ort.InferenceSession.create(`${BASE}models/board_photo_occupancy.onnx`),
    ort.InferenceSession.create(`${BASE}models/board_photo_pieces.onnx`),
  ]).catch((e) => {
    sessions = null;
    throw e;
  });
  return sessions;
}

/** Output order of the piece model (alphabetical class folders: black_bishop … white_rook). */
const PIECE_CLASSES = ["b", "k", "n", "p", "q", "r", "B", "K", "N", "P", "Q", "R"];

function softmax(logits: Float32Array, n: number, i: number): number[] {
  const row = Array.from(logits.subarray(i * n, i * n + n));
  const m = Math.max(...row);
  const e = row.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

export interface SquareGuess {
  occupied: number; // probability the square holds a piece
  pieces: number[]; // probabilities over PIECE_CLASSES
}

/** Classify all 64 squares. Result is in photo orientation: [row][col] as seen in the photo. */
export async function classifySquares(img: ImageData, corners: Point[]): Promise<SquareGuess[][]> {
  const [occS, pcsS] = await loadModels();
  const { occ, pcs } = buildInputs(img, corners);
  const occOut = await occS.run({ input: new ort.Tensor("float32", occ, [64, 3, 100, 100]) });
  const pcsOut = await pcsS.run({ input: new ort.Tensor("float32", pcs, [64, 3, 200, 100]) });
  const lo = occOut.logits.data as Float32Array;
  const lp = pcsOut.logits.data as Float32Array;
  const out: SquareGuess[][] = [];
  for (let r = 0; r < 8; r++) {
    const row: SquareGuess[] = [];
    for (let c = 0; c < 8; c++) {
      const i = r * 8 + c;
      row.push({ occupied: softmax(lo, 2, i)[1], pieces: softmax(lp, 12, i) });
    }
    out.push(row);
  }
  return out;
}

// ---------- turning guesses into a position ----------

/** Which edge of the photo White sits at, judged from where the white and black pieces are. */
export function guessWhiteSide(guesses: SquareGuess[][]): WhiteSide {
  let wr = 0,
    wc = 0,
    wn = 0,
    br = 0,
    bc = 0,
    bn = 0;
  guesses.forEach((row, r) =>
    row.forEach((g, c) => {
      if (g.occupied < 0.5) return;
      const k = g.pieces.indexOf(Math.max(...g.pieces));
      if (k >= 6) {
        wr += r;
        wc += c;
        wn++;
      } else {
        br += r;
        bc += c;
        bn++;
      }
    }),
  );
  if (!wn || !bn) return "bottom";
  const dv = br / bn - wr / wn; // > 0: white lower in the photo
  const dh = bc / bn - wc / wn; // > 0: white further left
  if (Math.abs(dv) >= Math.abs(dh)) return dv >= 0 ? "bottom" : "top";
  return dh >= 0 ? "left" : "right";
}

export interface Reading {
  grid: Grid; // board orientation (rank 8 first, a-file first)
  uncertain: boolean[][]; // same orientation; squares worth double-checking
  whiteSide: WhiteSide;
}

/** Turn per-square guesses into a board, with light chess-rule clean-up. */
export function decide(guesses: SquareGuess[][], whiteSide: WhiteSide): Reading {
  type Cell = { occupied: number; pieces: number[] };
  const photoCells = guesses.map((row) => row.map((g) => g as Cell | ""));
  // Re-orient a grid of cells using the same mapping as piece chars.
  const orient = <T,>(m: T[][]): T[][] => {
    const idx = m.map((row, r) => row.map((_, c) => `${r},${c}`));
    const mapped = photoGridToBoard(idx, whiteSide);
    return mapped.map((row) => row.map((key) => {
      const [r, c] = key.split(",").map(Number);
      return m[r][c];
    }));
  };
  const cells = orient(photoCells) as Cell[][];
  const grid: Grid = cells.map((row) => row.map(() => ""));
  const conf: number[][] = cells.map((row) => row.map(() => 1));
  const ranked = (p: number[]) => p.map((v, k) => [v, k] as const).sort((a, b) => b[0] - a[0]);

  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const cell = cells[r][c];
      if (cell.occupied < 0.5) {
        conf[r][c] = 1 - cell.occupied;
        continue;
      }
      let choices = ranked(cell.pieces);
      // No pawns on the first or last rank.
      if (r === 0 || r === 7) choices = choices.filter(([, k]) => PIECE_CLASSES[k].toLowerCase() !== "p");
      grid[r][c] = PIECE_CLASSES[choices[0][1]];
      conf[r][c] = Math.min(cell.occupied, choices[0][0]);
    }

  // Exactly one king per side when the evidence allows it.
  for (const king of ["K", "k"]) {
    const kIdx = PIECE_CLASSES.indexOf(king);
    const holders: [number, number][] = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (grid[r][c] === king) holders.push([r, c]);
    if (holders.length > 1) {
      holders.sort((a, b) => cells[b[0]][b[1]].pieces[kIdx] - cells[a[0]][a[1]].pieces[kIdx]);
      for (const [r, c] of holders.slice(1)) {
        const next = ranked(cells[r][c].pieces).find(([, k]) => k !== kIdx && !(PIECE_CLASSES[k].toLowerCase() === "p" && (r === 0 || r === 7)));
        if (next) {
          grid[r][c] = PIECE_CLASSES[next[1]];
          conf[r][c] = 0; // flag for review
        }
      }
    } else if (holders.length === 0) {
      let best: [number, number] | null = null;
      let bestP = 0.1;
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          const p = cells[r][c].occupied * cells[r][c].pieces[kIdx];
          if (p > bestP) {
            bestP = p;
            best = [r, c];
          }
        }
      if (best) {
        grid[best[0]][best[1]] = king;
        conf[best[0]][best[1]] = 0;
      }
    }
  }

  return { grid, uncertain: conf.map((row) => row.map((v) => v < 0.6)), whiteSide };
}
