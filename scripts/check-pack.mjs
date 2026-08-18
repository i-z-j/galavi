/**
 * Pack + isolated-install smoke (API-1/API-2/API-4/API-6): the published npm
 * artifact must be self-installing and keep the package boundary:
 *
 *   galavi             -> the common Viewer entry (side-effect-free)
 *   galavi/advanced    -> the low-level authoring entry (side-effect-free)
 *   galavi/ome-zarr    -> zarrita (runtime dependency, external to the bundle)
 *                         + the ONLY entry with a module-load side effect
 *                         (its dataset self-registration)
 *
 * `npm install galavi` alone must satisfy the north-star snippet — zarrita is
 * a regular dependency, not a peer. This script therefore:
 *
 *   1. rebuilds (`bun run build`);
 *   2. packs the tarball and checks its file list, exports map, dependency
 *      metadata (zarrita in `dependencies`, no peer declarations), and the
 *      narrowed `sideEffects` declaration;
 *   3. verifies the import graph (no core path may reach zarrita) and the
 *      bundles (zarrita-free root + advanced entries; no top-level dataset
 *      registration outside dist/ome-zarr.js; the OME-Zarr entry imports
 *      zarrita as an external, keeps its registration call, and its
 *      declarations carry the `DatasetConfigMap` augmentation). Declarations
 *      are NOT rolled up: dist mirrors src/ so every type has ONE identity
 *      across all three entries (advanced/ome-zarr re-export the shared
 *      declaration files instead of re-declaring them);
 *   4. installs ONLY the tarball into a temp project outside the workspace
 *      and asserts zarrita arrives transitively;
 *   5. asserts `import("galavi")`, `import("galavi/advanced")`, and
 *      `import("galavi/ome-zarr")` all resolve there — that the root does not
 *      re-export the moved engine names, and that the mesh/ome-zarr dataset
 *      registrations actually dispatch — and typechecks the consumer snippets
 *      (north-star, root-only, advanced, cross-entry type identity, plate
 *      config flow, moved-name/JSON-only rejections) against the installed
 *      package (with the package's own TypeScript).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc");

const EXPECTED_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/galavi.js",
  "package/dist/galavi.js.map",
  "package/dist/index.d.ts",
  "package/dist/advanced.js",
  "package/dist/advanced.js.map",
  "package/dist/advanced.d.ts",
  "package/dist/ome-zarr.js",
  "package/dist/ome-zarr.js.map",
  // Declarations mirror src/ (no rollup): the ome-zarr entry's types live at
  // their source path, and viewer/base are the SHARED declaration modules the
  // other entries reference (single identity per type across entries).
  "package/dist/dataset/ome-zarr.d.ts",
  "package/dist/dataset/base.d.ts",
  "package/dist/viewer.d.ts",
];

function fail(message) {
  console.error(`pack check FAILED: ${message}`);
  process.exit(1);
}

/** Assert the built artifacts keep the zarrita boundary and the typed augmentation. */
function checkBundles(root) {
  const core = readFileSync(join(root, "dist/galavi.js"), "utf8");
  if (core.includes("zarrita")) fail(`${root}/dist/galavi.js references zarrita — core import graph is not clean`);
  if (core.includes("sourceRegistry")) fail(`${root}/dist/galavi.js still references sourceRegistry`);
  const coreTypes = readFileSync(join(root, "dist/index.d.ts"), "utf8");
  if (coreTypes.includes("zarrita")) fail(`${root}/dist/index.d.ts references zarrita`);
  if (coreTypes.includes("sourceRegistry")) fail(`${root}/dist/index.d.ts still references sourceRegistry`);
  const advanced = readFileSync(join(root, "dist/advanced.js"), "utf8");
  if (advanced.includes("zarrita")) fail(`${root}/dist/advanced.js references zarrita`);
  const advancedTypes = readFileSync(join(root, "dist/advanced.d.ts"), "utf8");
  if (advancedTypes.includes("zarrita")) fail(`${root}/dist/advanced.d.ts references zarrita`);
  // Single identity per type across entries: the advanced entry must
  // RE-EXPORT the shared declarations, never re-declare them (a rolled-up
  // per-entry d.ts gives e.g. ViewerEngine a distinct nominal identity per
  // entry, breaking cross-entry assignability for consumers).
  if (/declare class ViewerEngine/.test(advancedTypes)) {
    fail(`${root}/dist/advanced.d.ts re-declares ViewerEngine — it must re-export ./viewer (no d.ts rollup)`);
  }
  if (!/export\s*\{[^}]*\bViewerEngine\b[^}]*\}\s*from\s*["']\.\/viewer["']/.test(advancedTypes)) {
    fail(`${root}/dist/advanced.d.ts does not re-export ViewerEngine from "./viewer"`);
  }
  // Side-effect discipline (API-6): package.json `sideEffects` covers ONLY
  // the OME-Zarr registration entry, so no other bundle may execute a dataset
  // registration at module scope — a bundler is allowed to drop it there.
  for (const [name, code] of [["dist/galavi.js", core], ["dist/advanced.js", advanced]]) {
    if (/registerDataset\s*\(\s*["']/.test(code)) {
      fail(
        `${root}/${name} registers a dataset at module scope — only dist/ome-zarr.js ` +
        "may carry that side effect (see the sideEffects declaration)",
      );
    }
  }
  const subpath = readFileSync(join(root, "dist/ome-zarr.js"), "utf8");
  if (!/from\s*["']zarrita["']/.test(subpath)) {
    fail(`${root}/dist/ome-zarr.js does not import zarrita as an external — was it bundled or tree-shaken away?`);
  }
  if (!/registerDataset\s*\(\s*["']ome-zarr["']/.test(subpath)) {
    fail(
      `${root}/dist/ome-zarr.js lost its module-scope registerDataset("ome-zarr") call — ` +
      "the registration side effect must survive bundling",
    );
  }
  const subpathTypes = readFileSync(join(root, "dist/dataset/ome-zarr.d.ts"), "utf8");
  if (!/^declare module "\.\/base"/m.test(subpathTypes)) {
    fail(
      `${root}/dist/dataset/ome-zarr.d.ts lost the DatasetConfigMap augmentation ` +
      '(consumers would not get the typed "ome-zarr" config) — it must survive ' +
      'declaration emission verbatim as declare module "./base"',
    );
  }
  // The augmentation must merge with the ONE shared DatasetConfigMap
  // declaration: the subpath must reference the root declarations (via
  // ./base), never carry its own rolled-up copy of the config union.
  if (/declare (type|interface) DatasetConfig(Map)?\b/.test(subpathTypes.replace(/declare module "\.\/base"[\s\S]*?\n\}/, ""))) {
    fail(
      `${root}/dist/dataset/ome-zarr.d.ts re-declares DatasetConfig/DatasetConfigMap outside ` +
      "the augmentation — PlateField.source would use an un-augmented mesh-only union",
    );
  }
  if (!/from\s*["']\.\/base["']/.test(subpathTypes)) {
    fail(`${root}/dist/dataset/ome-zarr.d.ts does not reference the shared ./base declarations`);
  }
}

// --- 0. Build (vite build: bundles + per-file declaration emit) ---
execFileSync("bun", ["run", "build"], { cwd: PACKAGE_ROOT, stdio: "inherit" });

for (const file of [
  "dist/galavi.js",
  "dist/index.d.ts",
  "dist/advanced.js",
  "dist/advanced.d.ts",
  "dist/ome-zarr.js",
  "dist/dataset/ome-zarr.d.ts",
]) {
  if (!existsSync(join(PACKAGE_ROOT, file))) fail(`${file} missing right after build`);
}

// --- 1. Source import graph: zarrita is imported only by src/dataset/ome-zarr.ts ---
{
  const zarritaImport = /(?:from\s*["']zarrita["']|import\(\s*["']zarrita["'])/;
  const stack = [join(PACKAGE_ROOT, "src")];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (path === join(PACKAGE_ROOT, "src", "dataset", "ome-zarr.ts")) continue;
      if (zarritaImport.test(readFileSync(path, "utf8"))) {
        fail(`${path} imports zarrita — only src/dataset/ome-zarr.ts may do that`);
      }
    }
  }
}

// --- 2. Built bundles (in the package root, before packing) ---
checkBundles(PACKAGE_ROOT);

const dir = mkdtempSync(join(tmpdir(), "galavi-pack-"));
const app = mkdtempSync(join(tmpdir(), "galavi-smoke-"));
try {
  const packed = execFileSync("npm", ["pack", "--pack-destination", dir, "--json"], {
    cwd: PACKAGE_ROOT,
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
    ["exports['./advanced'].types", manifest.exports?.["./advanced"]?.types],
    ["exports['./advanced'].import", manifest.exports?.["./advanced"]?.import],
    ["exports['./ome-zarr'].types", manifest.exports?.["./ome-zarr"]?.types],
    ["exports['./ome-zarr'].import", manifest.exports?.["./ome-zarr"]?.import],
  ];
  for (const [field, target] of entryPoints) {
    if (!target) fail(`manifest is missing ${field}`);
    const entry = `package/${target.replace(/^\.\//, "")}`;
    if (!listing.includes(entry)) fail(`${field} points at ${target}, absent from tarball`);
  }

  // Side effects (API-6): narrowed to exactly the OME-Zarr registration entry.
  const sideEffects = manifest.sideEffects;
  if (!Array.isArray(sideEffects) || sideEffects.join(",") !== "./dist/ome-zarr.js") {
    fail(`sideEffects must be exactly ["./dist/ome-zarr.js"], got: ${JSON.stringify(sideEffects)}`);
  }

  // Dependency metadata: wgpu-matrix + zarrita are plain runtime
  // dependencies; no peer declarations remain.
  const runtimeDeps = Object.keys(manifest.dependencies ?? {}).sort();
  if (runtimeDeps.join(",") !== "wgpu-matrix,zarrita") {
    fail(`runtime dependencies must be exactly ["wgpu-matrix", "zarrita"], got: ${JSON.stringify(runtimeDeps)}`);
  }
  if (manifest.peerDependencies || manifest.peerDependenciesMeta) {
    fail("no peerDependencies/peerDependenciesMeta may remain — zarrita is a regular dependency now");
  }

  // --- 3. Isolated install: ONLY the tarball, in a temp project outside the workspace ---
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "galavi-smoke", private: true, type: "module" }, null, 2),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], {
    cwd: app,
    stdio: "inherit",
  });

  // zarrita (and wgpu-matrix) must arrive transitively — no direct install.
  for (const dep of ["zarrita", "wgpu-matrix"]) {
    if (!existsSync(join(app, "node_modules", dep, "package.json"))) {
      fail(`isolated install did not bring in ${dep} transitively`);
    }
  }

  // The installed artifact keeps the bundle boundary too.
  checkBundles(join(app, "node_modules", "galavi"));

  // --- 4. All three entry points resolve and evaluate in the isolated project ---
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const core = await import("galavi");' +
      'if (typeof core.createViewer !== "function") throw new Error("galavi root entry broken");' +
      'if ("ViewerEngine" in core || "createViewerEngine" in core) ' +
      'throw new Error("galavi root still exports the engine — it moved to galavi/advanced (API-6)");' +
      'const advanced = await import("galavi/advanced");' +
      'if (typeof advanced.createViewerEngine !== "function") throw new Error("galavi/advanced entry broken");' +
      'if (typeof advanced.createViewer !== "function") throw new Error("galavi/advanced must re-export the common root");' +
      'const sub = await import("galavi/ome-zarr");' +
      'if (typeof sub.openOMEZarr !== "function") throw new Error("galavi/ome-zarr entry broken");' +
      // Registration side effects, functionally: both the lazy built-in
      // ("mesh", no module-load side effect) and the ome-zarr entry's
      // import-time registration must dispatch — a missing registration
      // surfaces as "Unknown dataset kind" (any load error means it dispatched).
      'for (const config of [{ type: "mesh", source: "https://example.invalid/m.obj" },' +
      ' { type: "ome-zarr", source: "https://example.invalid/x.zarr" }]) {' +
      'try { await core.openDataset(config); }' +
      'catch (e) { if (/Unknown dataset kind/.test(String(e))) ' +
      'throw new Error(`dataset registration missing for ${config.type}`); } }',
    ],
    { cwd: app, stdio: "inherit" },
  );

  // --- 5. Typecheck the consumer snippets against the installed package ---
  const snippet = join(app, "north-star.ts");
  writeFileSync(snippet, `
import { createViewer, type DatasetConfig } from "galavi";
import "galavi/ome-zarr";

const viewer = await createViewer("#app", {
  dataset: { type: "ome-zarr", source: "https://example.test/image.ome.zarr" },
});
viewer.mode = "slice";

// High-level ROI events (review §9.5): typed payloads, unsubscribe function,
// never a callback inside the JSON-only ViewerConfig.
const stop = viewer.on("roiChange", ({ rois, change, viewId, mode }) => {
  void [rois, change, viewId, mode];
});
viewer.on("roiActiveChange", ({ activeIndex, viewId, mode }) => {
  void [activeIndex, viewId, mode];
});
stop();

const mesh: DatasetConfig = { type: "mesh", source: "https://example.test/mesh.obj" };
void mesh;

// @ts-expect-error — "image" was the old OME-Zarr key; it is not a loader identity
const stale: DatasetConfig = { type: "image", source: "https://example.test/x" };
void stale;

// @ts-expect-error — the field is \`source\`; \`url\` is not a config field
const wrongField: DatasetConfig = { type: "ome-zarr", url: "https://example.test/x" };
void wrongField;

// @ts-expect-error — \`source\` is required
const missingSource: DatasetConfig = { type: "ome-zarr" };
void missingSource;
`);
  // Without the subpath import, "ome-zarr" must NOT typecheck.
  const rootOnly = join(app, "root-only.ts");
  writeFileSync(rootOnly, `
import { type DatasetConfig } from "galavi";

const mesh: DatasetConfig = { type: "mesh", source: "https://example.test/mesh.obj" };
void mesh;

// @ts-expect-error — without the galavi/ome-zarr import, "ome-zarr" is unknown
const zarr: DatasetConfig = { type: "ome-zarr", source: "https://example.test/x" };
void zarr;
`);
  // The advanced entry carries the low-level authoring surface (API-6),
  // including the callback-bearing overlay options (API-4).
  const advancedSnippet = join(app, "advanced.ts");
  writeFileSync(advancedSnippet, `
import {
  createViewer,
  createViewerEngine,
  type LayerConfig,
  type LayerPatch,
  type RoiSelectorOverlayOptions,
  type State,
  type ViewConfig,
} from "galavi/advanced";

const layers: LayerConfig[] = [];
const state: State = {
  layers,
  exploration: {
    camera: {
      navMode: "orbit",
      projMode: "perspective",
      position: [0, 0, 1],
      target: [0, 0, 0],
    },
  },
};
const views: Record<string, ViewConfig> = {};
const patch: LayerPatch = { id: "layer", render: { visible: true } };
void [state, views, patch, createViewer, createViewerEngine];

const roiOptions: RoiSelectorOverlayOptions = {
  onRoisChange: (rois, change) => { void rois; void change; },
  onActiveIndexChange: (index) => { void index; },
};
void roiOptions;
`);
  // The intentional breaks (API-4 + API-6) must hold at the consumer boundary.
  const rejections = join(app, "rejections.ts");
  writeFileSync(rejections, `
import { createViewer, type ViewerConfig } from "galavi";
void createViewer;

// @ts-expect-error — the engine moved to galavi/advanced; no root alias (API-6)
import { createViewerEngine } from "galavi";
void createViewerEngine;

// @ts-expect-error — the raw scene model moved to galavi/advanced (API-6)
import { type State } from "galavi";

// @ts-expect-error — high-level tool config is JSON-only (API-4)
const badTools: ViewerConfig = { tools: { roi: { onRoisChange: () => {} } } };
void badTools;

declare const viewer: import("galavi").Viewer;
// @ts-expect-error — the imperative tool path is equally JSON-only (API-4)
viewer.tool("roi").configure({ onActiveIndexChange: () => {} });
`);
  // Single type identity across entries: the Viewer's engine (typed from the
  // root entry) must be directly assignable to the ViewerEngine imported from
  // galavi/advanced — no NonNullable<Viewer["engine"]> workarounds.
  const identity = join(app, "identity.ts");
  writeFileSync(identity, `
import { createViewer, type Viewer } from "galavi";
import { createViewerEngine, type ViewerEngine } from "galavi/advanced";

const viewer = await createViewer("#app", {
  dataset: { type: "mesh", source: "https://example.test/mesh.obj" },
});

// One nominal identity: Viewer["engine"] IS the advanced entry's ViewerEngine.
const engine: ViewerEngine | undefined = viewer.engine;
void engine;

function takeEngine(value: ViewerEngine | undefined): void { void value; }
takeEngine(viewer.engine);

// And the reverse direction, through the class itself.
declare const anyEngine: ViewerEngine;
const asRootShape: NonNullable<Viewer["engine"]> = anyEngine;
void [asRootShape, createViewerEngine];
`);
  // The plate helpers carry the AUGMENTED DatasetConfig union: a field's
  // config opens directly, and an ome-zarr config literal is accepted
  // wherever a PlateField.source goes (the subpath must not use its own
  // un-augmented copy of the config union).
  const plate = join(app, "plate.ts");
  writeFileSync(plate, `
import { openDataset, type DatasetConfig } from "galavi";
import { openOMEZarrPlate, type OMEZarrPlateInfo, type PlateField } from "galavi/ome-zarr";

declare const info: OMEZarrPlateInfo;
const field: PlateField = info.wells[0].fields[0];

// field.source IS the shared, augmented DatasetConfig — openable directly.
const config: DatasetConfig = field.source;
void openDataset(field.source);
void config;

// ...and an ome-zarr config literal typechecks as a plate field source.
const rebuilt: PlateField = {
  index: 0,
  path: "0",
  source: { type: "ome-zarr", source: "https://example.test/plate.zarr/A/1/0" },
};
void [rebuilt, openOMEZarrPlate];
`);
  if (!existsSync(TSC)) fail(`TypeScript not found at ${TSC} — run bun install first`);
  for (const file of [snippet, rootOnly, advancedSnippet, rejections, identity, plate]) {
    execFileSync(
      process.execPath,
      [
        TSC,
        "--noEmit", "--strict", "--skipLibCheck",
        "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
        file,
      ],
      { cwd: app, stdio: "inherit" },
    );
  }

  console.log(
    `pack check OK: ${filename} carries ${EXPECTED_FILES.length} expected files, a consistent exports map, ` +
    "zarrita as a transitive runtime dependency, resolvable root + advanced + ome-zarr entries " +
    "(root/advanced side-effect-free, registration only in galavi/ome-zarr), " +
    "single-identity declarations shared across entries, " +
    "and consumer-side typed dataset configs",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(app, { recursive: true, force: true });
}
