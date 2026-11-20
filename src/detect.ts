// Automatic chessboard localisation in a photo (pure TypeScript, no dependencies).
//
// 1. Canny edges on a downscaled grey image.
// 2. Hough transform -> straight lines, split into the two grid directions.
// 3. RANSAC over pairs of neighbouring lines from each direction: each guess defines a
//    homography to "lattice" space where board lines sit on integers; keep the guess
//    under which the most line intersections land on integer points.
// 4. Refine the homography on all inliers, then pick the 8x8 window of lattice cells
//    that looks most like a chessboard (strong light/dark alternation).
// Inspired by chesscog's board localisation (Wölflein & Arandjelović, MIT).

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
export type P = [number, number];
type Line = { rho: number; theta: number; votes: number; t: number };

const WORK = 640;

export interface Detection {
  corners: P[]; // in the input image's pixel coordinates, any order
  score: number; // 0..1, how sure we are
}

export function detectBoard(img: Img): Detection | null {
  const scale = Math.min(1, WORK / Math.max(img.width, img.height));
  const W = Math.max(1, Math.round(img.width * scale));
  const H = Math.max(1, Math.round(img.height * scale));
  const gray = toGray(img, W, H);
  const blurred = gaussian(gray, W, H);
  const { edges, dir } = canny(blurred, W, H);
  const lines = hough(edges, dir, W, H);
  if (lines.length < 6) return null;
  const [A, B] = splitFamilies(lines);
  if (A.length < 3 || B.length < 3) return null;
  orderFamily(A, W, H);
  orderFamily(B, W, H);
  const fit = fitLattice(A, B, W, H);
  if (!fit) return null;
  const win = chooseWindow(fit.H, fit.inliers, blurred, W, H);
  if (!win) return null;
  const inv = invert3(fit.H);
  const corners = (
    [
      [win.x, win.y],
      [win.x + 8, win.y],
      [win.x + 8, win.y + 8],
      [win.x, win.y + 8],
    ] as P[]
  ).map(([x, y]) => {
    const [u, v] = applyH(inv, x, y);
    return [u / scale, v / scale] as P;
  });
  // Sanity: neighbouring squares must have similar sizes (perspective changes them slowly).
  for (const axis of [0, 1]) {
    for (const m of [0.5, 4, 7.5]) {
      const pts = Array.from({ length: 9 }, (_, k) =>
        axis === 0 ? applyH(inv, win.x + k, win.y + m) : applyH(inv, win.x + m, win.y + k),
      );
      const gaps = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]));
      for (let k = 1; k < gaps.length; k++) {
        const r = gaps[k] / gaps[k - 1];
        if (r > 1.35 || r < 1 / 1.35) return null;
      }
    }
  }
  // Sanity: the board must be reasonably big and mostly inside the photo.
  const area = Math.abs(polyArea(corners));
  if (area < 0.04 * img.width * img.height) return null;
  const inside = corners.filter(
    ([x, y]) => x > -0.05 * img.width && y > -0.05 * img.height && x < 1.05 * img.width && y < 1.05 * img.height,
  ).length;
  if (inside < 4) return null;
  const score = Math.min(1, fit.inliers.length / 40) * Math.min(1, win.contrast / 40);
  return { corners, score };
}

// ---------- image basics ----------

export function toGray(img: Img, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H);
  const sx = img.width / W,
    sy = img.height / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * sy),
      y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * sx),
        x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let s = 0,
        n = 0;
      // Box average, subsampled for speed on big photos.
      const stepY = Math.max(1, Math.floor((y1 - y0) / 3));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 3));
      for (let yy = y0; yy < y1; yy += stepY)
        for (let xx = x0; xx < x1; xx += stepX) {
          const i = (yy * img.width + xx) * 4;
          s += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          n++;
        }
      out[y * W + x] = s / n;
    }
  }
  return out;
}

export function gaussian(src: Float32Array, W: number, H: number): Float32Array {
  const k = [0.0625, 0.25, 0.375, 0.25, 0.0625];
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += k[i + 2] * src[y * W + Math.min(W - 1, Math.max(0, x + i))];
      tmp[y * W + x] = s;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += k[i + 2] * tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x];
      out[y * W + x] = s;
    }
  return out;
}

export function canny(g: Float32Array, W: number, H: number) {
  const mag = new Float32Array(W * H);
  const dir = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1];
      const gy = g[i + W - 1] + 2 * g[i + W] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - W] - g[i - W + 1];
      mag[i] = Math.hypot(gx, gy);
      dir[i] = Math.atan2(gy, gx);
    }
  // Non-maximum suppression.
  const nms = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const m = mag[i];
      if (m === 0) continue;
      let a = dir[i] < 0 ? dir[i] + Math.PI : dir[i];
      let d: number;
      if (a < Math.PI / 8 || a >= (7 * Math.PI) / 8) d = 1;
      else if (a < (3 * Math.PI) / 8) d = W + 1;
      else if (a < (5 * Math.PI) / 8) d = W;
      else d = W - 1;
      if (m >= mag[i + d] && m >= mag[i - d]) nms[i] = m;
    }
  // Thresholds from the magnitude distribution.
  const vals: number[] = [];
  for (let i = 0; i < nms.length; i += 3) if (nms[i] > 0) vals.push(nms[i]);
  vals.sort((a, b) => a - b);
  const hi = vals.length ? vals[Math.floor(vals.length * 0.8)] : 1;
  const lo = hi * 0.4;
  const edges = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let i = 0; i < nms.length; i++)
    if (nms[i] >= hi && !edges[i]) {
      edges[i] = 1;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        for (const o of [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1]) {
          const k = j + o;
          if (k >= 0 && k < nms.length && !edges[k] && nms[k] >= lo) {
            edges[k] = 1;
            stack.push(k);
          }
        }
      }
    }
  return { edges, dir };
}

// ---------- lines ----------

const NT = 360; // theta bins over [0, pi)

export function hough(edges: Uint8Array, dir: Float32Array, W: number, H: number): Line[] {
  const diag = Math.ceil(Math.hypot(W, H));
  const NR = 2 * diag + 1;
  const acc = new Int32Array(NT * NR);
  const cos = new Float32Array(NT),
    sin = new Float32Array(NT);
  for (let t = 0; t < NT; t++) {
    cos[t] = Math.cos((t * Math.PI) / NT);
    sin[t] = Math.sin((t * Math.PI) / NT);
  }
  const span = 16; // only vote near the gradient direction (±8°)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!edges[i]) continue;
      let a = dir[i];
      if (a < 0) a += Math.PI;
      const tc = Math.round((a / Math.PI) * NT);
      for (let dt = -span; dt <= span; dt++) {
        const t = (((tc + dt) % NT) + NT) % NT;
        const r = Math.round(x * cos[t] + y * sin[t]) + diag;
        acc[t * NR + r]++;
      }
    }
  // Peaks with non-maximum suppression.
  let max = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i];
  const thr = Math.max(25, max * 0.2);
  const cands: Line[] = [];
  const RW = 5,
    TW = 4;
  for (let t = 0; t < NT; t++)
    for (let r = 0; r < NR; r++) {
      const v = acc[t * NR + r];
      if (v < thr) continue;
      let isMax = true;
      for (let dt = -TW; dt <= TW && isMax; dt++)
        for (let dr = -RW; dr <= RW; dr++) {
          if (!dt && !dr) continue;
          let tt = t + dt,
            rr = r + dr;
          if (tt < 0) {
            tt += NT;
            rr = NR - 1 - rr;
          } else if (tt >= NT) {
            tt -= NT;
            rr = NR - 1 - rr;
          }
          if (rr < 0 || rr >= NR) continue;
          const o = acc[tt * NR + rr];
          if (o > v || (o === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      if (isMax) cands.push({ rho: r - diag, theta: (t * Math.PI) / NT, votes: v, t: 0 });
    }
  cands.sort((a, b) => b.votes - a.votes);
  return cands.slice(0, 70);
}

export function splitFamilies(lines: Line[]): [Line[], Line[]] {
  // k-means (k=2) on doubled angles so that 0 and pi coincide.
  const vec = lines.map((l) => [Math.cos(2 * l.theta), Math.sin(2 * l.theta)]);
  let c0 = vec[0];
  let c1 = vec.reduce((best, v) => (v[0] * c0[0] + v[1] * c0[1] < best[0] * c0[0] + best[1] * c0[1] ? v : best), vec[0]);
  let lab: number[] = [];
  for (let it = 0; it < 10; it++) {
    lab = vec.map((v) => ((v[0] - c0[0]) ** 2 + (v[1] - c0[1]) ** 2 <= (v[0] - c1[0]) ** 2 + (v[1] - c1[1]) ** 2 ? 0 : 1));
    const m = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    vec.forEach((v, i) => {
      m[lab[i]][0] += v[0] * lines[i].votes;
      m[lab[i]][1] += v[1] * lines[i].votes;
      m[lab[i]][2] += lines[i].votes;
    });
    if (m[0][2]) c0 = [m[0][0] / m[0][2], m[0][1] / m[0][2]];
    if (m[1][2]) c1 = [m[1][0] / m[1][2], m[1][1] / m[1][2]];
  }
  const A = lines.filter((_, i) => lab[i] === 0);
  const B = lines.filter((_, i) => lab[i] === 1);
  // Drop lines too far in angle from their family (pieces, table edges...).
  const prune = (F: Line[]) => {
    const c = F.reduce((s, l) => [s[0] + Math.cos(2 * l.theta), s[1] + Math.sin(2 * l.theta)], [0, 0]);
    const mean = Math.atan2(c[1], c[0]) / 2;
    return F.filter((l) => {
      let d = Math.abs(l.theta - mean) % Math.PI;
      d = Math.min(d, Math.PI - d);
      return d < (25 * Math.PI) / 180;
    });
  };
  return [prune(A), prune(B)];
}

/** Sort a family of roughly parallel lines across the image and drop near-duplicates. */
export function orderFamily(F: Line[], W: number, H: number) {
  const c = F.reduce((s, l) => [s[0] + Math.cos(2 * l.theta), s[1] + Math.sin(2 * l.theta)], [0, 0]);
  const mean = Math.atan2(c[1], c[0]) / 2;
  const n = [Math.cos(mean), Math.sin(mean)];
  const cx = W / 2,
    cy = H / 2;
  for (const l of F) {
    const u = [Math.cos(l.theta), Math.sin(l.theta)];
    const denom = n[0] * u[0] + n[1] * u[1];
    l.t = (l.rho - (cx * u[0] + cy * u[1])) / (Math.abs(denom) < 1e-6 ? 1e-6 : denom);
  }
  F.sort((a, b) => a.t - b.t);
  for (let i = F.length - 1; i > 0; i--) {
    if (Math.abs(F[i].t - F[i - 1].t) < 4) {
      if (F[i].votes > F[i - 1].votes) F.splice(i - 1, 1);
      else F.splice(i, 1);
    }
  }
}

function intersect(a: Line, b: Line): P | null {
  const ca = Math.cos(a.theta),
    sa = Math.sin(a.theta),
    cb = Math.cos(b.theta),
    sb = Math.sin(b.theta);
  const det = ca * sb - sa * cb;
  if (Math.abs(det) < 1e-6) return null;
  return [(a.rho * sb - b.rho * sa) / det, (ca * b.rho - cb * a.rho) / det];
}

// ---------- homographies ----------

type M3 = number[];

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Least-squares homography src -> dst (>= 4 pairs), with h33 = 1. */
function homography(src: P[], dst: P[]): M3 | null {
  const ATA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const ATb = new Array(8).fill(0);
  const add = (row: number[], v: number) => {
    for (let i = 0; i < 8; i++) {
      ATb[i] += row[i] * v;
      for (let j = 0; j < 8; j++) ATA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [x, y] = src[k],
      [u, v] = dst[k];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(ATA, ATb);
  return h ? [...h, 1] : null;
}

function applyH(H: M3, x: number, y: number): P {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function invert3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

function polyArea(p: P[]) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i],
      [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

// ---------- lattice fitting ----------

interface Fit {
  H: M3; // image (work res) -> lattice
  inliers: { p: P; q: P }[];
}

export function fitLattice(A: Line[], B: Line[], W: number, H: number): Fit | null {
  // All intersections of the two families that fall near the image.
  const pts: { p: P; i: number; j: number }[] = [];
  const grid: (P | null)[][] = A.map(() => B.map(() => null));
  A.forEach((a, i) =>
    B.forEach((b, j) => {
      const p = intersect(a, b);
      if (p && p[0] > -0.25 * W && p[0] < 1.25 * W && p[1] > -0.25 * H && p[1] < 1.25 * H) {
        pts.push({ p, i, j });
        grid[i][j] = p;
      }
    }),
  );
  if (pts.length < 9) return null;

  const TOL = 0.15;
  const score = (Hm: M3) => {
    let n = 0;
    for (const { p } of pts) {
      const [u, v] = applyH(Hm, p[0], p[1]);
      if (!isFinite(u) || Math.abs(u) > 14 || Math.abs(v) > 14) continue;
      if (Math.abs(u - Math.round(u)) < TOL && Math.abs(v - Math.round(v)) < TOL) n++;
    }
    return n;
  };

  let best: M3 | null = null;
  let bestScore = 0;
  const STEP = 4;
  for (let i1 = 0; i1 < A.length; i1++)
    for (let i2 = i1 + 1; i2 <= Math.min(A.length - 1, i1 + STEP); i2++)
      for (let j1 = 0; j1 < B.length; j1++)
        for (let j2 = j1 + 1; j2 <= Math.min(B.length - 1, j1 + STEP); j2++) {
          const q = [grid[i1][j1], grid[i2][j1], grid[i2][j2], grid[i1][j2]];
          if (q.some((x) => !x)) continue;
          const quad = q as P[];
          if (Math.abs(polyArea(quad)) < 40) continue;
          for (const da of [1, 2])
            for (const db of [1, 2]) {
              const Hm = homography(quad, [
                [0, 0],
                [da, 0],
                [da, db],
                [0, db],
              ]);
              if (!Hm) continue;
              const s = score(Hm);
              if (s > bestScore) {
                bestScore = s;
                best = Hm;
              }
            }
        }
  if (!best || bestScore < 12) return null;

  // Refine on all inliers (twice, as the inlier set may grow).
  let Hm = best;
  let inliers: { p: P; q: P }[] = [];
  for (let it = 0; it < 3; it++) {
    inliers = [];
    for (const { p } of pts) {
      const [u, v] = applyH(Hm, p[0], p[1]);
      if (!isFinite(u) || Math.abs(u) > 14 || Math.abs(v) > 14) continue;
      const ru = Math.round(u),
        rv = Math.round(v);
      if (Math.abs(u - ru) < TOL && Math.abs(v - rv) < TOL) inliers.push({ p, q: [ru, rv] });
    }
    // If (nearly) every inlier sits on even lattice columns, the guess used half-size
    // squares (a frame line can sit at the half step): collapse that axis so one
    // lattice unit is one board square, dropping the few odd ones.
    for (const ax of [0, 1]) {
      for (let rep = 0; rep < 2; rep++) {
        const par = (v: number) => ((v % 2) + 2) % 2;
        const distinct = [new Set<number>(), new Set<number>()];
        for (const x of inliers) distinct[par(x.q[ax])].add(x.q[ax]);
        const keep = distinct[0].size >= distinct[1].size ? 0 : 1;
        if (distinct[keep].size < 5 || distinct[1 - keep].size > 2) break;
        inliers = inliers.filter((x) => par(x.q[ax]) === keep);
        for (const x of inliers) x.q[ax] = (x.q[ax] - keep) / 2;
      }
    }
    const next = homography(
      inliers.map((x) => x.p),
      inliers.map((x) => x.q),
    );
    if (!next) break;
    Hm = next;
  }
  return inliers.length >= 12 ? { H: Hm, inliers } : null;
}

/** Choose the 8x8 block of lattice cells with the strongest checkerboard pattern. */
function chooseWindow(Hm: M3, inliers: { p: P; q: P }[], gray: Float32Array, W: number, H: number) {
  const xs = inliers.map((x) => x.q[0]),
    ys = inliers.map((x) => x.q[1]);
  const xmin = Math.min(...xs),
    xmax = Math.max(...xs),
    ymin = Math.min(...ys),
    ymax = Math.max(...ys);
  const inv = invert3(Hm);
  const X0 = Math.min(xmin, xmax - 8) - 1,
    X1 = Math.max(xmax, xmin + 8) + 1;
  const Y0 = Math.min(ymin, ymax - 8) - 1,
    Y1 = Math.max(ymax, ymin + 8) + 1;
  // Median brightness of the middle of every lattice cell in range.
  const cell = new Map<string, number>();
  for (let cx = X0; cx < X1; cx++)
    for (let cy = Y0; cy < Y1; cy++) {
      const vals: number[] = [];
      for (let a = 0.3; a <= 0.71; a += 0.1)
        for (let b = 0.3; b <= 0.71; b += 0.1) {
          const [u, v] = applyH(inv, cx + a, cy + b);
          const x = Math.round(u),
            y = Math.round(v);
          if (x >= 0 && y >= 0 && x < W && y < H) vals.push(gray[y * W + x]);
        }
      if (vals.length >= 12) {
        vals.sort((p, q) => p - q);
        cell.set(`${cx},${cy}`, vals[vals.length >> 1]);
      }
    }
  const med = (v: number[]) => {
    if (!v.length) return NaN;
    const t = [...v].sort((p, q) => p - q);
    return t[t.length >> 1];
  };
  let best: { x: number; y: number; contrast: number } | null = null;
  for (let x = X0; x <= X1 - 8; x++)
    for (let y = Y0; y <= Y1 - 8; y++) {
      let missing = 0;
      const even: number[] = [],
        odd: number[] = [];
      const v = (i: number, j: number) => cell.get(`${x + i},${y + j}`);
      for (let i = 0; i < 8; i++)
        for (let j = 0; j < 8; j++) {
          const c = v(i, j);
          if (c === undefined) missing++;
          else ((i + j) % 2 ? odd : even).push(c);
        }
      if (missing > 12) continue;
      const sign = med(even) > med(odd) ? 1 : -1;
      // Every one of the 8 columns and 8 rows must alternate light/dark the same way;
      // a border strip or the table next to the board does not.
      let total = 0;
      for (let k = 0; k < 8; k++)
        for (const col of [true, false]) {
          const e: number[] = [],
            o: number[] = [];
          for (let m = 0; m < 8; m++) {
            const c = col ? v(k, m) : v(m, k);
            if (c === undefined) continue;
            ((col ? k + m : m + k) % 2 ? o : e).push(c);
          }
          const d = sign * (med(e) - med(o));
          total += isNaN(d) ? 0 : Math.max(0, d);
        }
      const contrast = total / 16;
      if (!best || contrast > best.contrast) best = { x, y, contrast };
    }
  return best && best.contrast > 8 ? best : null;
}
