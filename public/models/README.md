---
license: mit
library_name: onnx
tags:
  - chess
  - onnx
  - computer-vision
---

# Chess board photo classifiers, ONNX

Two MobileNetV3-Small classifiers for reading a photo of a physical chessboard, used by
[CrispChess](https://github.com/CrispStrobe/CrispChess) together with a Dart port of
[chesscog](https://github.com/georg-wolflein/chesscog)'s board localisation and crops
(Georg Wölflein and Ognjen Arandjelović, *J. Imaging* 2021, MIT).

| File | Input | Output |
|---|---|---|
| `board_photo_occupancy.onnx` | 100×100 square crops (chesscog's occupancy crop) | empty / occupied |
| `board_photo_pieces.onnx` | 100×200 piece crops (chesscog's piece crop) | 12 piece classes |

Trained for CrispChess (MIT) from torchvision's ImageNet-initialised MobileNetV3-Small
(BSD-3) on:

- chesscog's synthetic renders (OSF xf3ka), CC BY 4.0;
- [samryan18/chess-dataset](https://github.com/samryan18/chess-dataset), © 2019 Samuel Ryan,
  Mukund Venkateswaran, Kurt Convey, Michael Deng, MIT;
- Roboflow 100 "chess pieces" (`chess-pieces-mjzgj`), CC BY 4.0.

**Accuracy** (end to end with the localiser): 99.6–99.9% of squares on held-out photos of
the piece sets seen in training; 85% of squares (every error a piece type or colour) on
chesscog's photos of an unseen wooden set. Unusual sets need checking.
