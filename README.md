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

- Board recognition models: [cstr/chess-board-photo-onnx](https://huggingface.co/cstr/chess-board-photo-onnx) (MIT), from CrispChess. The square-crop method is from [chesscog](https://github.com/georg-wolflein/chesscog) by Georg Wölflein & Ognjen Arandjelović (MIT). See `public/models/README.md` for the training-data credits.
- Stockfish: GPLv3 (`public/engine/LICENSE-stockfish.txt`).
- Piece images: "cburnett" by Colin M.L. Burnett.
