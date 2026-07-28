import build from "@hono/vite-build/cloudflare-pages";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  if (mode === "client") {
    return {
      base: "/static/",
      plugins: [react()],
      build: {
        outDir: "dist/static",
        emptyOutDir: true,
        copyPublicDir: false,
        rollupOptions: {
          input: "src/client.tsx",
          output: {
            entryFileNames: "client.js",
            chunkFileNames: "chunks/[name]-[hash].js",
            assetFileNames: (asset) =>
              asset.names.some((name) => name.endsWith(".css"))
                ? "client.css"
                : "assets/[name]-[hash][extname]",
          },
        },
      },
    };
  }

  return {
    plugins: [
      react(),
      build({
        entry: "src/worker.tsx",
        emptyOutDir: true,
      }),
    ],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      copyPublicDir: true,
      target: "es2022",
    },
  };
});
