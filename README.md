# ♞ Chess Scanner

Scan a chess board with your phone camera. The app reads the position and shows:

- **Best move for White and for Black** (plus 2 alternatives each), drawn as arrows on the board
- **An evaluation bar** showing who has the upper hand, with a plain-language verdict ("White is clearly better", "Black has mate in 3", …)

Everything runs **on your phone**. There's no account, no API key, and no server, so anyone can use it for free.

**Open it:** https://avidor12.github.io/chess_anlayzer/ (on your phone, use "Add to Home Screen" to get an app icon)

## How it works

1. **Scan**: tap *Scan a board*. The camera opens inside the app; frame the board and press the shutter. You can also upload a photo instead.
2. **Find the board**: the app finds the 8×8 grid in the photo by itself (edge detection → line fitting → a perspective lattice fit). If it can't, it asks you to drag 4 corners, with a magnifier to help.
3. **Read the pieces**: two small neural networks (MobileNetV3, about 6 MB each, run with onnxruntime-web) decide for each square whether it's empty and which piece is on it. The app works out which side White is on, applies basic chess rules, and marks with a dashed outline any square it's unsure about.
4. **Analyze**: Stockfish 19 (WebAssembly) finds the best move for both sides right away, and the bar shows who's ahead. If only one side can legally be to move, the app picks that side for you. Tap any square to fix a piece, and the analysis updates.

After the first visit it works offline (a service worker keeps a copy of the app, the engine and the models).

Recognition works best on standard tournament-style (Staunton) pieces with even light. Unusual or decorative sets may need a few squares corrected.

## Development

```bash
npm install
npm run dev        # serves on your LAN, so you can open it on your phone
npm run build      # production build in dist/
```

For the camera to open directly, phones need the page served over **HTTPS** (or from `localhost`).

### Deploy to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes the app on every push to `main`.
Turn it on once in **Settings → Pages → Source: GitHub Actions**.

## Tech & credits

Vite + TypeScript, no framework. `chess.js` handles legality checks and move notation, Stockfish 19 lite (single-threaded WASM, in `public/engine/`) handles analysis, and onnxruntime-web runs the recognition models.

- **Board finding** (`src/detect.ts`): ChESS X-corner detection (Bennett & Lasenby) plus a Hough line method, each fitted to a perspective lattice. It's inspired by [chesscog](https://github.com/georg-wolflein/chesscog) (Wölflein & Arandjelović, MIT).
- **Piece model** (`public/models/pieces.onnx`): MobileNetV3-Large, trained for this app on about 45,000 pieces from labelled photos of real boards: ChessReD (Masouris & van Gemert), Roboflow "chess pieces" and surawut/chess-pieces-dataset-yolo. Because ChessReD is CC BY-NC-SA 4.0, **this model is CC BY-NC-SA 4.0 (non-commercial use only)**. See `public/models/README.md`.
- **Empty/occupied model**: from [cstr/chess-board-photo-onnx](https://huggingface.co/cstr/chess-board-photo-onnx) (MIT).
- Stockfish: GPLv3 (`public/engine/LICENSE-stockfish.txt`).
- Piece images: "cburnett" by Colin M.L. Burnett.

### Measured accuracy

The test photos come from games that were never used for training:

| Test set | Board found | Piece errors / board (before → now) | Perfect boards (before → now) |
|---|---|---|---|
| Tournament board, many angles (ChessReD game 0) | 38% → 83% | 7.3 → 0.4 | 0 → 50 of 86 |
| Black-and-white board, from above | → 86% | 8.1 → 2.8 | 0 → 0 of 37 |
| Green board (Roboflow test) | 100% | 0.07 → 0.03 | 54 → 56 of 58 |
