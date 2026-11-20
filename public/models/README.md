# Board recognition models

Two ONNX image classifiers read a photo of a physical chessboard, one square at a time,
after the board has been located (`src/detect.ts`) and each square cut out with
[chesscog](https://github.com/georg-wolflein/chesscog)'s crop geometry (Georg Wölflein and
Ognjen Arandjelović, *J. Imaging* 2021, MIT).

| File | Input | Output |
|---|---|---|
| `board_photo_occupancy.onnx` | 100×100 square crop | empty / occupied |
| `pieces.onnx` | 100×200 piece crop (taller, so the whole piece is in view) | 12 piece classes |

Inputs are RGB, scaled to 0–1 and normalised with the ImageNet mean and std, NCHW.
Piece classes, in output order: `b k n p q r B K N P Q R` (lower case black, upper case white).

## `pieces.onnx` — trained for this app

MobileNetV3-Large (timm `mobilenetv3_large_100.ra_in1k`, ImageNet weights, Apache-2.0),
fine-tuned on ~45,000 piece crops cut from labelled photos of real boards:

- **ChessReD** — Athanasios Masouris and Jan van Gemert, *End-to-End Chess Recognition*,
  VISAPP 2024 (photos taken by the authors), **CC BY-NC-SA 4.0**, via
  [acapitani/chesspiece-detection-yolo](https://huggingface.co/datasets/acapitani/chesspiece-detection-yolo)
  (MIT for the annotations and additional photos);
- Roboflow "chess pieces" (`chess-pieces-mjzgj`), **CC BY 4.0**;
- [surawut/chess-pieces-dataset-yolo](https://huggingface.co/datasets/surawut/chess-pieces-dataset-yolo), **CC BY 4.0**.

Because part of its training data is CC BY-NC-SA 4.0, **this model is released under
CC BY-NC-SA 4.0: free to use, share and adapt for non-commercial purposes, with credit,
under the same licence.**

## `board_photo_occupancy.onnx`

From [cstr/chess-board-photo-onnx](https://huggingface.co/cstr/chess-board-photo-onnx)
(MIT), trained for [CrispChess](https://github.com/CrispStrobe/CrispChess) from
MobileNetV3-Small on chesscog's synthetic renders (CC BY 4.0), samryan18/chess-dataset
(MIT) and Roboflow "chess pieces" (CC BY 4.0).
