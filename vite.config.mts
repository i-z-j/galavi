import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      include: ["src/**/*"],
      rollupTypes: true,
    }),
  ],
  build: {
    target: "es2022",
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: "src/index.ts",
        "ome-zarr": "src/dataset/ome-zarr.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) =>
        entryName === "index" ? "galavi.js" : `${entryName}.js`,
    },
    outDir: "dist",
    rollupOptions: {
      external: ["wgpu-matrix", "zarrita"],
    },
  },
});
