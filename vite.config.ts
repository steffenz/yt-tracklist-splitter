import { defineConfig } from "vite";

// Tauri expects a fixed port and no obfuscation of the dev server address.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // don't watch the Rust side
      ignored: ["**/src-tauri/**"],
    },
  },
  // Produce assets Tauri can serve from a relative base.
  build: {
    target: "es2021",
    minify: false,
    sourcemap: true,
  },
});
