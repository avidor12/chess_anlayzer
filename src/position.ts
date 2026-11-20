import { Chess } from "chess.js";

/** grid[row][col]: row 0 = rank 8, col 0 = a-file. '' = empty, otherwise FEN piece char. */
export type Grid = string[][];
export type Side = "w" | "b";
export type WhiteSide = "bottom" | "top" | "left" | "right";

export const emptyGrid = (): Grid => Array.from({ length: 8 }, () => Array(8).fill(""));

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Convert a grid read in photo orientation into board orientation (rank 8 on top, a-file left). */
export function photoGridToBoard(photo: Grid, whiteSide: WhiteSide): Grid {
  const g = emptyGrid();
  for (let rank = 0; rank < 8; rank++) {
    // rank 0 = rank 1
    for (let file = 0; file < 8; file++) {
      let p: string;
      switch (whiteSide) {
        case "bottom":
          p = photo[7 - rank][file];
          break;
        case "top":
          p = photo[rank][7 - file];
          break;
        case "left":
          p = photo[file][rank];
          break;
        case "right":
          p = photo[7 - file][7 - rank];
          break;
      }
      g[7 - rank][file] = p;
    }
  }
  return g;
}

/** Rotate the pieces 90° clockwise (useful if recognition guessed the wrong orientation). */
export function rotateGrid(g: Grid): Grid {
  const out = emptyGrid();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) out[c][7 - r] = g[r][c];
  return out;
}

export function placementToGrid(placement: string): Grid {
  const g = emptyGrid();
  const rows = placement.split("/");
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r] ?? "") {
      if (/\d/.test(ch)) c += Number(ch);
      else if (c < 8) g[r][c++] = ch;
    }
  }
  return g;
}

export function gridToPlacement(g: Grid): string {
  return g
    .map((row) => {
      let s = "";
      let empty = 0;
      for (const p of row) {
        if (!p) empty++;
        else {
          if (empty) s += empty;
          empty = 0;
          s += p;
        }
      }
      return empty ? s + empty : s;
    })
    .join("/");
}

export interface Castling {
  K: boolean;
  Q: boolean;
  k: boolean;
  q: boolean;
}

/** Castling is only possible if king and rook are still on their home squares. */
export function possibleCastling(g: Grid): Castling {
  return {
    K: g[7][4] === "K" && g[7][7] === "R",
    Q: g[7][4] === "K" && g[7][0] === "R",
    k: g[0][4] === "k" && g[0][7] === "r",
    q: g[0][4] === "k" && g[0][0] === "r",
  };
}

export function toFen(g: Grid, turn: Side, c: Castling): string {
  const allowed = possibleCastling(g);
  let cs = "";
  if (c.K && allowed.K) cs += "K";
  if (c.Q && allowed.Q) cs += "Q";
  if (c.k && allowed.k) cs += "k";
  if (c.q && allowed.q) cs += "q";
  return `${gridToPlacement(g)} ${turn} ${cs || "-"} - 0 1`;
}

/** Returns an error message if the position can't be analysed with `turn` to move, else null. */
export function checkPosition(g: Grid, turn: Side, c: Castling): string | null {
  const flat = g.flat();
  const count = (p: string) => flat.filter((x) => x === p).length;
  if (count("K") !== 1) return `White must have exactly one king (found ${count("K")}).`;
  if (count("k") !== 1) return `Black must have exactly one king (found ${count("k")}).`;
  if (count("P") > 8 || count("p") > 8) return "A side has more than 8 pawns.";
  if (g[0].some((p) => p.toLowerCase() === "p") || g[7].some((p) => p.toLowerCase() === "p"))
    return "Pawns can't be on the first or last rank.";
  try {
    const chess = new Chess(toFen(g, turn, c));
    // The side that just moved must not be left in check.
    const other: Side = turn === "w" ? "b" : "w";
    const otherKing = chess
      .board()
      .flat()
      .find((s) => s && s.type === "k" && s.color === other);
    if (otherKing && chess.isAttacked(otherKing.square, turn))
      return `${other === "w" ? "White" : "Black"} is in check, so it can't be ${turn === "w" ? "White" : "Black"}'s turn.`;
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

/** Convert a UCI principal variation to SAN moves. */
export function pvToSan(fen: string, pv: string[], max = 6): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, max)) {
    try {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      out.push(m.san);
    } catch {
      break;
    }
  }
  return out;
}

export function gameStatus(fen: string): "checkmate" | "stalemate" | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  return null;
}
