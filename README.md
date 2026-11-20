# ♞ Chess Scanner

Scan a chess board with your phone camera. The app reads the position and shows:

- **Best move for White and for Black** (plus 2 alternatives each), drawn as arrows on the board
- **An evaluation bar** showing who has the upper hand, with a plain-language verdict ("White is clearly better", "Black has mate in 3", …)

## How it works

1. **Scan**: take a photo (or pick one from your gallery). Claude's vision model (`claude-opus-5-5`) reads the 64 squares and works out which side of the photo White is on, so you can shoot from any side of the board.
2. **Check**: the position appears on an editable board. Tap a square, then pick a piece to fix any mistakes. You can also rotate, flip, reset, clear, set castling rights, or paste a FEN.
3. **Analyze**: Stockfish 19 (WebAssembly) runs **on your phone**. It finds the best move with White to move and with Black to move. Choose whose turn it really is, and the eval bar shows the score from that side's point of view.

## Setup

You need an [Anthropic API key](https://console.anthropic.com/settings/keys) for photo recognition. Tap ⚙︎ in the app and paste it. The key stays in your browser's local storage and goes only to `api.anthropic.com`. Without a key you can still set up the position by hand and analyze it.

### Run locally

```bash
npm install
npm run dev        # serves on your LAN, so you can open it on your phone
```

Phone cameras need **HTTPS** (or `localhost`) for the camera input to open the camera directly. The easiest way is to deploy:

### Deploy to GitHub Pages

The workflow in `.github/workflows/deploy.yml` builds and publishes the app on every push to `main`.
Turn it on in **Settings → Pages → Source: GitHub Actions**. The app is then available at
`https://<user>.github.io/chess_anlayzer/`. Open it on your phone and use "Add to Home Screen" to get an app icon.

## Tips for good scans

- Shoot from above or at a moderate angle, with the whole board in frame
- Even lighting, no strong glare
- If the pieces come out rotated, use **Rotate pieces 90°**

## Tech

Vite + TypeScript, no framework. `chess.js` handles legality checks and move notation, `stockfish` 19 lite (single-threaded WASM, about 1.8 MB, in `public/engine/`) handles analysis, and `@anthropic-ai/sdk` with structured outputs handles board recognition.

Licenses: Stockfish is GPLv3 (`public/engine/LICENSE-stockfish.txt`). The piece set is "cburnett" by Colin M.L. Burnett.
