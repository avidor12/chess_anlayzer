// Board recognition from a photo using Claude's vision.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Grid } from "./position";

const MODEL = "claude-opus-5-5";

const BoardReading = z.object({
  rows: z
    .array(z.string())
    .describe(
      "Exactly 8 strings, one per row of squares AS SEEN IN THE PHOTO from the top row to the bottom row. " +
        "Each string has exactly 8 characters, left to right as seen in the photo. " +
        "Use K Q R B N P for white pieces, k q r b n p for black pieces, and . for an empty square.",
    ),
  white_side: z
    .enum(["bottom", "top", "left", "right"])
    .describe("Which edge of the photo is White's side of the board (where White's pieces started)."),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string().describe("Short note about anything uncertain (e.g. an occluded square). Empty if none."),
});
export type BoardReading = z.infer<typeof BoardReading>;

const PROMPT = `This photo shows a physical (or on-screen) chess board with a game in progress.
Read the position square by square.

Instructions:
1. First locate the 8x8 grid of the board in the photo, even if it is photographed at an angle.
2. Report the grid exactly as it appears in the photo: row 1 of your answer is the row of squares nearest the TOP of the image, and each row is read LEFT to RIGHT in the image. Do not rotate or flip it.
3. Decide which edge of the photo is White's side. Use the board's printed coordinates if visible (rank "1" and the a-file are White's side / White's left), the light square in each player's right-hand corner, and where the pieces are clustered.
4. Identify every piece carefully. Distinguish bishops from pawns and kings from queens by their tops (king: cross, queen: crown/coronet, bishop: mitre with slit). Distinguish piece colour by the piece itself, not the square colour.
5. Double-check: count the pieces of each colour; there must be exactly one king per side and at most 8 pawns per side.`;

export interface RecognizeOptions {
  apiKey: string;
  image: { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };
  signal?: AbortSignal;
}

export async function recognizeBoard({ apiKey, image, signal }: RecognizeOptions): Promise<BoardReading> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const response = await client.beta.messages.parse(
    {
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: betaZodOutputFormat(BoardReading) },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    },
    { signal },
  );

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to read this image. Try another photo.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("The response was cut off. Please try again.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Could not read the board from the response. Please try again.");
  return parsed;
}

/** Normalise the model's rows into a strict 8x8 grid of piece chars ('' = empty). */
export function rowsToPhotoGrid(rows: string[]): Grid {
  const grid: Grid = [];
  for (let r = 0; r < 8; r++) {
    const raw = (rows[r] ?? "").replace(/\s+/g, "");
    const row: string[] = [];
    for (let c = 0; c < 8; c++) {
      const ch = raw[c] ?? ".";
      row.push(/^[KQRBNPkqrbnp]$/.test(ch) ? ch : "");
    }
    grid.push(row);
  }
  return grid;
}

/** Downscale a photo so the long edge is at most `maxEdge` px and encode as JPEG base64. */
export async function prepareImage(file: Blob, maxEdge = 1568): Promise<{ data: string; mediaType: "image/jpeg"; url: string }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", 0.88);
  return { data: url.slice(url.indexOf(",") + 1), mediaType: "image/jpeg", url };
}
