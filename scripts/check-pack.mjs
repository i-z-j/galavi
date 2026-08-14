/**
 * Pack assertion: the published npm artifact must contain the built bundles
 * and type declarations referenced by the `exports` map, and the package
 * boundary must hold:
 *
 *   galavi core        -> wgpu-matrix (only runtime dependency)
 *   galavi/ome-zarr    -> zarrita (optional peer dependency)
 *
 * Packs into a temp dir and inspects the tarball's file list and manifest,
 * then verifies the import graph (no core path may reach zarrita) and the
 * dependency metadata. Requires a prior `bun run build` (dist/ is not
 * rebuilt here).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/galavi.js",
  "package/dist/galavi.js.map",
  "package/dist/index.d.ts",
  "package/dist/ome-zarr.js",
  "package/dist/ome-zarr.js.map",
  "package/dist/ome-zarr.d.ts",
];

function fail(message) {
  console.error(`pack check FAILED: ${message}`);
  process.exit(1);
}

for (const file of ["dist/galavi.js", "dist/index.d.ts", "dist/ome-zarr.js", "dist/ome-zarr.d.ts"]) {
  if (!existsSync(file)) fail("dist/ is missing or incomplete — run `bun run build` first");
}

// --- Source import graph: zarrita is imported only by src/dataset/ome-zarr.ts ---
{
  const zarritaImport = /(?:from\s*["']zarrita["']|import\(\s*["']zarrita["'])/;
  const stack = ["src"];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (path === join("src", "dataset", "ome-zarr.ts")) continue;
      if (zarritaImport.test(readFileSync(path, "utf8"))) {
        fail(`${path} imports zarrita — only src/dataset/ome-zarr.ts may do that`);
      }
    }
  }
}

// --- Built bundles: core never reaches zarrita; the subpath keeps it external ---
{
  const core = readFileSync("dist/galavi.js", "utf8");
  if (core.includes("zarrita")) fail("dist/galavi.js references zarrita — core import graph is not clean");
  if (core.includes("sourceRegistry")) fail("dist/galavi.js still references sourceRegistry");
  const coreTypes = readFileSync("dist/index.d.ts", "utf8");
  if (coreTypes.includes("zarrita")) fail("dist/index.d.ts references zarrita");
  if (coreTypes.includes("sourceRegistry")) fail("dist/index.d.ts still references sourceRegistry");
  const subpath = readFileSync("dist/ome-zarr.js", "utf8");
  if (!/from\s*["']zarrita["']/.test(subpath)) {
    fail("dist/ome-zarr.js does not import zarrita as an external — was it bundled or tree-shaken away?");
  }
}

const dir = mkdtempSync(join(tmpdir(), "galavi-pack-"));
try {
  const packed = execFileSync("npm", ["pack", "--pack-destination", dir, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [{ filename }] = JSON.parse(packed);
  const tarball = join(dir, filename);

  // File list: every expected file must be present.
  const listing = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
    .split("\n")
    .map((entry) => entry.trim());
  for (const expected of EXPECTED_FILES) {
    if (!listing.includes(expected)) fail(`tarball is missing ${expected}`);
  }

  // Manifest: exports/types must resolve to files inside the tarball.
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
  if (manifest.main || manifest.module) {
    fail("manifest still declares redundant main/module fields");
  }
  const entryPoints = [
    ["types", manifest.types],
    ["exports['.'].types", manifest.exports?.["."]?.types],
    ["exports['.'].import", manifest.exports?.["."]?.import],
    ["exports['./ome-zarr'].types", manifest.exports?.["./ome-zarr"]?.types],
    ["exports['./ome-zarr'].import", manifest.exports?.["./ome-zarr"]?.import],
  ];
  for (const [field, target] of entryPoints) {
    if (!target) fail(`manifest is missing ${field}`);
    const entry = `package/${target.replace(/^\.\//, "")}`;
    if (!listing.includes(entry)) fail(`${field} points at ${target}, absent from tarball`);
  }

  // Dependency metadata: exactly one runtime dependency; zarrita optional peer only.
  const runtimeDeps = Object.keys(manifest.dependencies ?? {});
  if (runtimeDeps.length !== 1 || runtimeDeps[0] !== "wgpu-matrix") {
    fail(`core runtime dependencies must be exactly ["wgpu-matrix"], got: ${JSON.stringify(runtimeDeps)}`);
  }
  if (manifest.peerDependenciesMeta?.zarrita?.optional !== true) {
    fail("zarrita must be an optional peer dependency (peerDependenciesMeta.zarrita.optional)");
  }
  if (!manifest.peerDependencies?.zarrita) {
    fail("zarrita must be declared as a peer dependency");
  }

  console.log(`pack check OK: ${filename} carries ${EXPECTED_FILES.length} expected files, a consistent exports map, and a zarrita-free core bundle`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
