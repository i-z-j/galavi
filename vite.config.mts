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
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "galavi",
    },
    outDir: "dist",
    rollupOptions: {
      external: ["wgpu-matrix"],
    },
  },
});
