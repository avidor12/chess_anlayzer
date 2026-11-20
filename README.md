# ♞ Chess Scanner

Scan a chess board with your phone camera. The app reads the position and shows:

- **Best move for White and for Black** (plus 2 alternatives each), drawn as arrows on the board
- **An evaluation bar** showing who has the upper hand, with a plain-language verdict ("White is clearly better", "Black has mate in 3", …)

Everything runs **on your phone**. There's no account, no API key, and no server, so anyone can use it for free.

**Open it:** https://avidor12.github.io/chess_anlayzer/ (on your phone, use "Add to Home Screen" to get an app icon)

## How it works

1. **Scan**: take a photo of the board from a player's side, then drag the 4 green circles onto the corners of the 64 squares. A magnifier helps you place them exactly. The app remembers the corners for your next scan.
2. **Read**: two small neural networks (MobileNetV3, about 6 MB each, run with onnxruntime-web) decide for each square whether it's empty and which piece is on it. The app works out which side White is on, applies basic chess rules (one king each, no pawns on the back ranks), and outlines in red any square it's unsure about.
3. **Check**: fix any mistake by tapping a square and picking a piece. You can also rotate, flip, reset, clear, set castling rights, or paste a FEN.
4. **Analyze**: Stockfish 19 (WebAssembly) finds the best move with White to move and with Black to move. Choose whose turn it really is, and the eval bar shows the score from that side's point of view.

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
