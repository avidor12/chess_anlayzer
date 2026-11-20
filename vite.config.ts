import { defineConfig } from "vite";

// base "./" makes the build work from any sub-path (e.g. GitHub Pages /chess_anlayzer/).
export default defineConfig({
  base: "./",
  server: { host: true },
  preview: { host: true },
});
