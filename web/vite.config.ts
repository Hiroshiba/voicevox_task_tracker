import { resolve } from "node:path";

import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

import { loadWebConfig } from "../src/config/index.js";

const webConfig = await loadWebConfig(new URL("../config.yml", import.meta.url));

export default defineConfig({
  root: import.meta.dirname,
  base: webConfig.basePath,
  plugins: [preact()],
  publicDir: "public",
  define: {
    __VOICEVOX_TRACKER_LOCALE__: JSON.stringify(webConfig.defaultLocale),
    __VOICEVOX_TRACKER_TITLE__: JSON.stringify(webConfig.title),
  },
  build: {
    outDir: resolve(import.meta.dirname, "../dist/web"),
    emptyOutDir: true,
  },
});
