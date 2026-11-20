# Board recognition models

Two ONNX image classifiers read a photo of a physical chessboard, one square at a time,
after the board has been located (`src/detect.ts`) and each square cut out with
[chesscog](https://github.com/georg-wolflein/chesscog)'s crop geometry (Georg Wölflein and
Ognjen Arandjelović, *J. Imaging* 2021, MIT).

| File | Input | Output |
|---|---|---|
| `occupancy.onnx` | 100×100 square crop | empty / occupied |
| `occupancy_small.onnx` | 100×100 square crop | empty / occupied (averaged with the one above) |
| `pieces.onnx` | 100×200 piece crop (taller, so the whole piece is in view) | 12 piece classes |

Inputs are RGB, scaled to 0–1 and normalised with the ImageNet mean and std, NCHW.
Piece classes, in output order: `b k n p q r B K N P Q R` (lower case black, upper case white).

## Both models were trained for this app

MobileNetV3-Large (timm `mobilenetv3_large_100.ra_in1k`, ImageNet weights, Apache-2.0),
fine-tuned on crops cut from labelled photos of real boards: ~45,000 piece crops for
`pieces.onnx` and ~86,000 empty/occupied square crops for `occupancy.onnx`. Weights are stored as float16.
Sources:

- **ChessReD** — Athanasios Masouris and Jan van Gemert, *End-to-End Chess Recognition*,
  VISAPP 2024 (photos taken by the authors), **CC BY-NC-SA 4.0**, via
  [acapitani/chesspiece-detection-yolo](https://huggingface.co/datasets/acapitani/chesspiece-detection-yolo)
  (MIT for the annotations and additional photos);
- Roboflow "chess pieces" (`chess-pieces-mjzgj`), **CC BY 4.0**;
- [surawut/chess-pieces-dataset-yolo](https://huggingface.co/datasets/surawut/chess-pieces-dataset-yolo), **CC BY 4.0**.

Because part of their training data is CC BY-NC-SA 4.0, **these models are released under
CC BY-NC-SA 4.0: free to use, share and adapt for non-commercial purposes, with credit,
under the same licence.**

## Measured accuracy

None of the test photos were used for training. The first set is a whole game the models never
saw. The black-and-white and green board styles do appear in other training photos (about
70 and 200 photos). These numbers are end to end, with the app's own board finder:

| Test set | Board found | Squares right | Perfect boards |
|---|---|---|---|
| Tournament board, many camera angles (ChessReD game 0, 103 photos) | 83% | 99.3% | 63 of 86 |
| Black-and-white board, mostly from straight above (43 photos) | 86% | 95.1% | 1 of 37 |
| Green tournament board (Roboflow test, 58 photos) | 100% | 99.95% | 56 of 58 |

The original models (cstr/chess-board-photo-onnx, MIT) reached 88%, 86% and 99.9% of
squares on the same sets.

## `occupancy_small.onnx`

`board_photo_occupancy.onnx` from [cstr/chess-board-photo-onnx](https://huggingface.co/cstr/chess-board-photo-onnx)
(MIT), from [CrispChess](https://github.com/CrispStrobe/CrispChess). It's a MobileNetV3-Small
trained on chesscog's synthetic renders (CC BY 4.0), samryan18/chess-dataset (MIT) and
Roboflow "chess pieces" (CC BY 4.0). Averaging it with `occupancy.onnx` is more robust on
noisy, low-resolution and unusual photos than either model alone.

## Credits

The crop geometry and the idea of two square classifiers come from chesscog.
