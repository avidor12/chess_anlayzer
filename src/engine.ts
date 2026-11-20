// Thin wrapper around the Stockfish WASM worker (UCI protocol over postMessage).

export interface PvLine {
  multipv: number;
  depth: number;
  /** Score from the perspective of the side to move. */
  cp?: number;
  mate?: number;
  pv: string[];
}

export interface SearchResult {
  bestmove: string | null;
  lines: PvLine[];
}

type Listener = (line: string) => void;

export class Engine {
  private worker: Worker;
  private listeners = new Set<Listener>();
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(url: string) {
    this.worker = new Worker(url);
    this.worker.onmessage = (e: MessageEvent) => {
      const line = typeof e.data === "string" ? e.data : String(e.data);
      for (const l of [...this.listeners]) l(line);
    };
    this.ready = (async () => {
      await this.sendAndWait("uci", (l) => l === "uciok");
      this.send("setoption name MultiPV value 3");
      await this.sendAndWait("isready", (l) => l === "readyok");
    })();
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private sendAndWait(cmd: string, done: (line: string) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const l: Listener = (line) => {
        if (done(line)) {
          this.listeners.delete(l);
          resolve();
        }
      };
      this.listeners.add(l);
      this.send(cmd);
    });
  }

  whenReady() {
    return this.ready;
  }

  /** Analyse a FEN for `movetime` ms. Calls are serialised. */
  analyse(fen: string, movetime: number, onInfo?: (r: SearchResult) => void): Promise<SearchResult> {
    const run = async (): Promise<SearchResult> => {
      await this.ready;
      this.send("ucinewgame");
      await this.sendAndWait("isready", (l) => l === "readyok");
      const lines = new Map<number, PvLine>();
      const snapshot = (bestmove: string | null): SearchResult => ({
        bestmove,
        lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv),
      });
      return new Promise((resolve) => {
        const l: Listener = (line) => {
          if (line.startsWith("info") && line.includes(" pv ")) {
            const info = parseInfo(line);
            if (info) {
              lines.set(info.multipv, info);
              onInfo?.(snapshot(null));
            }
          } else if (line.startsWith("bestmove")) {
            this.listeners.delete(l);
            const mv = line.split(/\s+/)[1];
            resolve(snapshot(mv && mv !== "(none)" ? mv : null));
          }
        };
        this.listeners.add(l);
        this.send(`position fen ${fen}`);
        this.send(`go movetime ${movetime}`);
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  stop() {
    this.send("stop");
  }
}

function parseInfo(line: string): PvLine | null {
  const t = line.split(/\s+/);
  const out: PvLine = { multipv: 1, depth: 0, pv: [] };
  for (let i = 0; i < t.length; i++) {
    switch (t[i]) {
      case "depth":
        out.depth = Number(t[++i]);
        break;
      case "multipv":
        out.multipv = Number(t[++i]);
        break;
      case "score": {
        const kind = t[++i];
        const val = Number(t[++i]);
        if (kind === "cp") out.cp = val;
        else if (kind === "mate") out.mate = val;
        break;
      }
      case "pv":
        out.pv = t.slice(i + 1);
        i = t.length;
        break;
    }
  }
  if (!out.pv.length || (out.cp === undefined && out.mate === undefined)) return null;
  return out;
}
