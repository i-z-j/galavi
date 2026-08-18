import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      include: ["src/**/*"],
      // No type rollup: emitted declarations mirror src/ and cross-reference
      // each other, so every type has ONE identity across the root, advanced,
      // and ome-zarr entries (rolled-up per-entry bundles each re-declared the
      // shared classes/interfaces, splitting their nominal identity). This
      // also preserves the `declare module "galavi"` DatasetConfigMap
      // augmentation in dist/dataset/ome-zarr.d.ts verbatim.
      rollupTypes: false,
    }),
  ],
  build: {
    target: "es2022",
    minify: false,
    sourcemap: true,
    lib: {
      entry: {
        index: "src/index.ts",
        advanced: "src/advanced.ts",
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
