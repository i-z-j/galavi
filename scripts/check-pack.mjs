/**
 * Pack + isolated-install smoke: the published npm artifact must be
 * self-installing and keep the package boundary:
 *
 *   galavi             -> the ONE main entry: facade + state + dataset +
 *                         composition + runtime + primitives + utils
 *                         (side-effect-free)
 *   galavi/ome-zarr    -> zarrita (runtime dependency, external to the bundle)
 *                         + the ONLY entry with a module-load side effect
 *                         (its dataset self-registration)
 *
 * State transport is plain JSON (`JSON.stringify`/`JSON.parse`);
 * `validateState`/`normalizeState` are root-entry exports.
 *
 * `npm install galavi` alone must satisfy the north-star snippet — zarrita is
 * a regular dependency, not a peer. This script therefore:
 *
 *   1. rebuilds (`bun run build`);
 *   2. packs the tarball and checks its file list, exports map, dependency
 *      metadata (wgpu-matrix + zarrita in `dependencies`, no peer
 *      declarations), and the narrowed `sideEffects` declaration;
 *   3. verifies the import graph (no core path may reach zarrita; nothing may
 *      reach fflate) and the bundles (zarrita-free root entry; no top-level
 *      dataset registration outside dist/ome-zarr.js; the OME-Zarr entry
 *      imports zarrita as an external, keeps its registration call, and its
 *      declarations carry the `DatasetConfigMap` augmentation). Declarations
 *      are NOT rolled up: dist mirrors src/ so every type has ONE identity
 *      across the entries (ome-zarr re-exports or references the shared
 *      declaration files instead of re-declaring them);
 *   4. installs ONLY the tarball into a temp project outside the workspace
 *      and asserts zarrita arrives transitively;
 *   5. asserts `import("galavi")` and `import("galavi/ome-zarr")` resolve
 *      there, that the root carries the low-level runtime surface (runtime,
 *      primitives, utils), that the mesh/ome-zarr dataset registrations
 *      actually dispatch, that `validateState` accepts a portable State and
 *      rejects function-backed values, and that the `mesh`/`omeZarr`
 *      descriptor helpers return JSON-stable configs that dispatch to the
 *      right dataset classes (while an unregistered kind keeps its
 *      actionable missing-registration error); a production vite build of a
 *      consumer that imports ONLY `omeZarr` proves the registration side
 *      effect survives tree-shaking — and typechecks the consumer snippets
 *      (north-star, root-only, low-level surface, JSON-only rejections,
 *      descriptor helpers, state schema) against the installed package
 *      (with the package's own TypeScript).
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
  "package/dist/ome-zarr.js",
  "package/dist/ome-zarr.js.map",
  // Declarations mirror src/ (no rollup): the ome-zarr entry's types live at
  // their source path (dist/dataset/adapters/), the scene vocabulary/
  // validation lives in dist/state/, and the viewer/dataset declaration
  // modules are the SHARED modules the other entry references (single
  // identity per type across entries).
  "package/dist/dataset/adapters/ome-zarr.d.ts",
  "package/dist/dataset/contract.d.ts",
  "package/dist/dataset/index.d.ts",
  "package/dist/state/schema.d.ts",
  "package/dist/viewer/index.d.ts",
  "package/dist/viewer/contract.d.ts",
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
  if (core.includes("fflate")) fail(`${root}/dist/galavi.js references fflate — JSON is the transport`);
  const coreTypes = readFileSync(join(root, "dist/index.d.ts"), "utf8");
  if (coreTypes.includes("zarrita")) fail(`${root}/dist/index.d.ts references zarrita`);
  if (coreTypes.includes("sourceRegistry")) fail(`${root}/dist/index.d.ts still references sourceRegistry`);
  if (coreTypes.includes("fflate")) fail(`${root}/dist/index.d.ts references fflate`);
  // Single identity per type across entries: the root entry must RE-EXPORT
  // the shared declarations, never re-declare them (a rolled-up per-entry
  // d.ts gives e.g. ViewerRuntime a distinct nominal identity per entry,
  // breaking cross-entry assignability for consumers).
  if (/declare class ViewerRuntime/.test(coreTypes)) {
    fail(`${root}/dist/index.d.ts re-declares ViewerRuntime — it must re-export ./viewer (no d.ts rollup)`);
  }
  if (!/export\s*\{[^}]*\bViewerRuntime\b[^}]*\}\s*from\s*["']\.\/viewer["']/.test(coreTypes)) {
    fail(`${root}/dist/index.d.ts does not re-export ViewerRuntime from "./viewer"`);
  }
  // Side-effect discipline: package.json `sideEffects` covers ONLY the
  // OME-Zarr registration entry, so no other bundle may execute a dataset
  // registration at module scope — a bundler is allowed to drop it there.
  for (const [name, code] of [["dist/galavi.js", core]]) {
    if (/registerDatasetAdapter\s*\(\s*["']/.test(code)) {
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
  if (!/registerDatasetAdapter\s*\(\s*["']ome-zarr["']/.test(subpath)) {
    fail(
      `${root}/dist/ome-zarr.js lost its module-scope registerDatasetAdapter("ome-zarr") call — ` +
      "the registration side effect must survive bundling",
    );
  }
  const subpathTypes = readFileSync(join(root, "dist/dataset/adapters/ome-zarr.d.ts"), "utf8");
  if (!/^declare module "\.\.\/\.\.\/state\/schema"/m.test(subpathTypes)) {
    fail(
      `${root}/dist/dataset/adapters/ome-zarr.d.ts lost the DatasetConfigMap augmentation ` +
      '(consumers would not get the typed "ome-zarr" config) — it must survive ' +
      'declaration emission verbatim as declare module "../../state/schema"',
    );
  }
  // The augmentation must merge with the ONE shared DatasetConfigMap
  // declaration: the subpath must reference the shared declarations (via
  // ../../state/schema), never carry its own rolled-up copy of the config union.
  if (/declare (type|interface) DatasetConfig(Map)?\b/.test(subpathTypes.replace(/declare module "\.\.\/\.\.\/state\/schema"[\s\S]*?\n\}/, ""))) {
    fail(
      `${root}/dist/dataset/adapters/ome-zarr.d.ts re-declares DatasetConfig/DatasetConfigMap outside ` +
      "the augmentation — PlateField.source would use an un-augmented mesh-only union",
    );
  }
  if (!/from\s*["']\.\.\/contract["']/.test(subpathTypes)) {
    fail(`${root}/dist/dataset/adapters/ome-zarr.d.ts does not reference the shared ../contract declarations`);
  }
}

// --- 0. Build (vite build: bundles + per-file declaration emit) ---
execFileSync("bun", ["run", "build"], { cwd: PACKAGE_ROOT, stdio: "inherit" });

for (const file of [
  "dist/galavi.js",
  "dist/index.d.ts",
  "dist/ome-zarr.js",
  "dist/dataset/adapters/ome-zarr.d.ts",
  "dist/state/schema.d.ts",
]) {
  if (!existsSync(join(PACKAGE_ROOT, file))) fail(`${file} missing right after build`);
}

// --- 1. Source import graph: zarrita is imported only by src/dataset/adapters/ome-zarr.ts,
//        and fflate is imported NOWHERE (JSON is the transport) ---
{
  const zarritaImport = /(?:from\s*["']zarrita["']|import\(\s*["']zarrita["'])/;
  const fflateImport = /(?:from\s*["']fflate["']|import\(\s*["']fflate["'])/;
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
      if (path !== join(PACKAGE_ROOT, "src", "dataset", "adapters", "ome-zarr.ts") && zarritaImport.test(readFileSync(path, "utf8"))) {
        fail(`${path} imports zarrita — only src/dataset/adapters/ome-zarr.ts may do that`);
      }
      if (fflateImport.test(readFileSync(path, "utf8"))) {
        fail(`${path} imports fflate — JSON is the transport`);
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
    ["exports['./ome-zarr'].types", manifest.exports?.["./ome-zarr"]?.types],
    ["exports['./ome-zarr'].import", manifest.exports?.["./ome-zarr"]?.import],
  ];
  for (const [field, target] of entryPoints) {
    if (!target) fail(`manifest is missing ${field}`);
    const entry = `package/${target.replace(/^\.\//, "")}`;
    if (!listing.includes(entry)) fail(`${field} points at ${target}, absent from tarball`);
  }

  // Side effects: narrowed to exactly the OME-Zarr registration entry.
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
    fail("no peerDependencies/peerDependenciesMeta may remain — zarrita is a regular dependency");
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

  // --- 4. Both entry points resolve and evaluate in the isolated project ---
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const core = await import("galavi");' +
      'if (typeof core.createViewer !== "function") throw new Error("galavi root entry broken");' +
      // The root entry also carries the low-level runtime surface:
      // runtime, registries, primitives, utils.
      'if (typeof core.createViewerRuntime !== "function" || typeof core.ViewerRuntime !== "function") ' +
      'throw new Error("galavi root is missing the low-level runtime surface (ViewerRuntime/createViewerRuntime)");' +
      'if (typeof core.registerLayer !== "function" || typeof core.registerView !== "function" ||' +
      ' typeof core.registerControl !== "function" || typeof core.registerOverlay !== "function") ' +
      'throw new Error("galavi root is missing the registry helpers");' +
      'if (typeof core.BaseLayer !== "function" || typeof core.BaseView !== "function" ||' +
      ' typeof core.BaseControl !== "function" || typeof core.BaseOverlay !== "function") ' +
      'throw new Error("galavi root is missing the primitive base classes");' +
      'if (typeof core.TilePool !== "function" || typeof core.planTiles !== "function") ' +
      'throw new Error("galavi root is missing the tile utilities");' +
      'if (typeof core.registerComposition !== "function") ' +
      'throw new Error("galavi root is missing registerComposition (the composition extension point)");' +
      'if ("getDatasetCapabilities" in core) ' +
      'throw new Error("compositions own support — there is no dataset capability API");' +
      'const sub = await import("galavi/ome-zarr");' +
      'if (typeof sub.openOMEZarr !== "function") throw new Error("galavi/ome-zarr entry broken");' +
      'if (typeof sub.OMEZarrDataset !== "function") throw new Error("galavi/ome-zarr is missing OMEZarrDataset");' +
      // State transport is plain JSON: the schema surface (validateState /
      // normalizeState) is a root-level export.
      'if (typeof core.validateState !== "function" || typeof core.normalizeState !== "function") ' +
      'throw new Error("galavi root is missing validateState/normalizeState");' +
      'const probeState = {' +
      ' layers: [{ id: "volume-c0", type: "volume", data: { url: "https://example.invalid/x.zarr" } }],' +
      ' exploration: { camera: { navMode: "fly", projMode: "orthographic", position: [2, 2, 12], target: [2, 2, 4] } },' +
      ' composition: { type: "volume" },' +
      ' channels: [{ index: 0, label: "DAPI µm 通道", visible: true, color: "#00B0FF", contrast: [0.1, 0.9] }],' +
      ' projection: "mip",' +
      '};' +
      'const validated = core.validateState(JSON.parse(JSON.stringify(probeState)));' +
      'if (JSON.stringify(validated) !== JSON.stringify(probeState)) ' +
      'throw new Error("validateState JSON round trip mismatch: " + JSON.stringify(validated));' +
      'let fnRejected = false;' +
      'try { core.validateState({ layers: [{ id: "l", type: "volume", data: { fetch: async () => new ArrayBuffer(0) } }], exploration: probeState.exploration }); }' +
      'catch (e) { fnRejected = /is a function/.test(String(e)); }' +
      'if (!fnRejected) throw new Error("validateState must reject function-backed values, not drop them");' +
      // Registration side effects, functionally: both the lazy built-in
      // ("mesh", no module-load side effect) and the ome-zarr entry's
      // import-time registration must dispatch — a missing registration
      // surfaces as "Unknown dataset kind" (any load error means it dispatched).
      'for (const config of [{ type: "mesh", source: "https://example.invalid/m.obj" },' +
      ' { type: "ome-zarr", source: "https://example.invalid/x.zarr" }]) {' +
      'try { await core.openDataset(config); }' +
      'catch (e) { if (/Unknown dataset kind/.test(String(e))) ' +
      'throw new Error(`dataset registration missing for ${config.type}`); } }' +
      // Named descriptor helpers: both entries export them, the results are
      // exactly `{ type, source }` (plain JSON, round-trip-stable)…
      'if (typeof core.mesh !== "function") throw new Error("galavi root is missing the mesh() descriptor helper");' +
      'if (typeof sub.omeZarr !== "function") throw new Error("galavi/ome-zarr is missing the omeZarr() descriptor helper");' +
      'const meshConfig = core.mesh("https://example.invalid/m.obj");' +
      'const zarrConfig = sub.omeZarr("https://example.invalid/x.zarr");' +
      'if (JSON.stringify(meshConfig) !== \'{"type":"mesh","source":"https://example.invalid/m.obj"}\') ' +
      'throw new Error("mesh() must return exactly { type, source }");' +
      'if (JSON.stringify(zarrConfig) !== \'{"type":"ome-zarr","source":"https://example.invalid/x.zarr"}\') ' +
      'throw new Error("omeZarr() must return exactly { type, source }");' +
      'for (const cfg of [meshConfig, zarrConfig]) {' +
      'if (JSON.stringify(JSON.parse(JSON.stringify(cfg))) !== JSON.stringify(cfg)) ' +
      'throw new Error("descriptor helper result is not JSON-stable: " + JSON.stringify(cfg)); }' +
      // …and each descriptor dispatches to its dataset class: mesh() must
      // construct a MeshDataset (a stubbed fetch serves one OBJ triangle);
      // omeZarr() must reach OMEZarrDataset (its wrapped store-open failure
      // names the format).
      'globalThis.fetch = async () => new Response("v 0 0 0\\nv 1 0 0\\nv 0 1 0\\nf 1 2 3\\n", { status: 200 });' +
      'const meshDataset = await core.openDataset(meshConfig);' +
      'if (meshDataset.constructor.name !== "MeshDataset") ' +
      'throw new Error("mesh() did not dispatch to MeshDataset, got " + meshDataset.constructor.name);' +
      'globalThis.fetch = async () => new Response("not found", { status: 404 });' +
      'try { await core.openDataset(zarrConfig); ' +
      'throw new Error("ome-zarr open unexpectedly succeeded"); }' +
      'catch (e) { if (!/Failed to open OME-Zarr dataset/.test(String(e))) ' +
      'throw new Error("omeZarr() did not dispatch to OMEZarrDataset: " + e); }',
    ],
    { cwd: app, stdio: "inherit" },
  );

  // --- 5. Missing registration keeps its actionable error (manual/third-party configs) ---
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      // Root entry only — the ome-zarr kind is NOT registered here.
      'const core = await import("galavi");' +
      'try {' +
      'await core.openDataset({ type: "ome-zarr", source: "https://example.invalid/x.zarr" });' +
      'throw new Error("open unexpectedly succeeded");' +
      '} catch (e) {' +
      'if (!/Unknown dataset kind: "ome-zarr".*import "galavi\\/ome-zarr"/.test(String(e))) ' +
      'throw new Error("missing-registration error lost its import hint: " + e);' +
      '}',
    ],
    { cwd: app, stdio: "inherit" },
  );

  // --- 6. Production tree-shaking: importing only omeZarr keeps the registration ---
  // A consumer bundler may include galavi/ome-zarr solely for the omeZarr
  // descriptor helper; the module's registerDatasetAdapter("ome-zarr") side effect
  // must survive production tree-shaking (the sideEffects declaration covers
  // exactly that bundle).
  const VITE = join(PACKAGE_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(VITE)) fail(`vite not found at ${VITE} — run bun install first`);
  const treeshakeEntry = join(app, "treeshake-entry.mjs");
  const treeshakeOut = join(app, "treeshake-dist");
  writeFileSync(treeshakeEntry, `
import { omeZarr } from "galavi/ome-zarr";
import { openDataset } from "galavi";

export const outcome = (async () => {
  try {
    await openDataset(omeZarr("https://example.invalid/x.ome.zarr"));
    return "opened-unexpectedly";
  } catch (error) {
    // Any failure EXCEPT a missing registration proves the kind dispatched.
    return /Unknown dataset kind/.test(String(error)) ? "registration-lost" : "dispatched";
  }
})();
`);
  writeFileSync(join(app, "vite.treeshake.config.mjs"), `
export default {
  logLevel: "silent",
  build: {
    target: "es2022",
    minify: true,
    lib: {
      entry: ${JSON.stringify(treeshakeEntry)},
      formats: ["es"],
      fileName: () => "treeshake.mjs",
    },
    outDir: ${JSON.stringify(treeshakeOut)},
    emptyOutDir: true,
  },
};
`);
  execFileSync(
    process.execPath,
    [VITE, "build", "--config", join(app, "vite.treeshake.config.mjs")],
    { cwd: app, stdio: "inherit" },
  );
  const treeshakeBundle = join(treeshakeOut, "treeshake.mjs");
  if (!existsSync(treeshakeBundle)) fail("tree-shaking probe bundle was not emitted");
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const mod = await import(process.env.TREESHAKE_BUNDLE);' +
      'const outcome = await mod.outcome;' +
      'if (outcome !== "dispatched") throw new Error(' +
      '"ome-zarr registration did not survive production tree-shaking: " + outcome);',
    ],
    {
      cwd: app,
      stdio: "inherit",
      env: { ...process.env, TREESHAKE_BUNDLE: treeshakeBundle },
    },
  );

  // --- 7. Typecheck the consumer snippets against the installed package ---
  const snippet = join(app, "north-star.ts");
  writeFileSync(snippet, `
import { createViewer, type DatasetConfig } from "galavi";
import "galavi/ome-zarr";

const viewer = await createViewer("#app", {
  dataset: { type: "ome-zarr", source: "https://example.test/image.ome.zarr" },
});
// Composition transitions are awaitable operations — no property assignment.
await viewer.setComposition({ type: "slice" });

// High-level ROI events: typed payloads, unsubscribe function,
// never a callback inside the JSON-only ViewerConfig.
const stop = viewer.on("roiChange", ({ rois, change, viewId, composition }) => {
  void [rois, change, viewId, composition];
});
viewer.on("roiActiveChange", ({ activeIndex, viewId, composition }) => {
  void [activeIndex, viewId, composition];
});
stop();

const mesh: DatasetConfig = { type: "mesh", source: "https://example.test/mesh.obj" };
void mesh;

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
  // The root entry also carries the low-level authoring surface, including
  // the callback-bearing overlay options the JSON-only facade config excludes.
  const lowLevelSnippet = join(app, "low-level.ts");
  writeFileSync(lowLevelSnippet, `
import {
  createViewer,
  createViewerRuntime,
  type CompositionPlan,
  type LayerConfig,
  type LayerPatch,
  type RoiSelectorOverlayOptions,
  type State,
  type ViewConfig,
  type ViewerComposition,
} from "galavi";

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
void [state, views, patch, createViewer, createViewerRuntime];

// The composition contract: the plan + composition types resolve from the
// root entry.
const plan: CompositionPlan | null = null;
const composition: ViewerComposition | null = null;
void [plan, composition];

const roiOptions: RoiSelectorOverlayOptions = {
  onRoisChange: (rois, change) => { void rois; void change; },
  onActiveIndexChange: (index) => { void index; },
};
void roiOptions;
`);
  // The JSON-purity and entry-shape assertions must hold at the consumer
  // boundary.
  const rejections = join(app, "rejections.ts");
  writeFileSync(rejections, `
import { createViewer, type ViewerConfig } from "galavi";
void createViewer;

import { createViewerRuntime } from "galavi";
void createViewerRuntime;

// The unified State is the root's portable document (facade + runtime).
import { type State } from "galavi";
const rootState: State | null = null;
void rootState;

// @ts-expect-error — high-level tool config is JSON-only
const badTools: ViewerConfig = { tools: { roi: { onRoisChange: () => {} } } };
void badTools;

declare const viewer: import("galavi").Viewer;
// @ts-expect-error — the imperative tool path is equally JSON-only
viewer.tool("roi").configure({ onActiveIndexChange: () => {} });

// @ts-expect-error — getState()/setState() use the unified State; there is no ViewerState type
type StaleViewerState = import("galavi").ViewerState;
void (0 as unknown as StaleViewerState | undefined);
`);
  // Single type identity across entries: the Viewer's runtime (typed from
  // the root entry) must be directly assignable to the ViewerRuntime
  // imported from the same root entry — no NonNullable<Viewer["runtime"]>
  // workarounds.
  const identity = join(app, "identity.ts");
  writeFileSync(identity, `
import { createViewer, createViewerRuntime, type Viewer, type ViewerRuntime } from "galavi";

const viewer = await createViewer("#app", {
  dataset: { type: "mesh", source: "https://example.test/mesh.obj" },
});

// One nominal identity: Viewer["runtime"] IS the root entry's ViewerRuntime.
const runtime: ViewerRuntime | undefined = viewer.runtime;
void runtime;

function takeRuntime(value: ViewerRuntime | undefined): void { void value; }
takeRuntime(viewer.runtime);

// And the reverse direction, through the class itself.
declare const anyRuntime: ViewerRuntime;
const asRootShape: NonNullable<Viewer["runtime"]> = anyRuntime;
void [asRootShape, createViewerRuntime];
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
  // The named descriptor helpers: exact DatasetConfigMap members, droppable
  // into ViewerConfig.dataset, with required-string source and no
  // extra/runtime values.
  const helpers = join(app, "helpers.ts");
  writeFileSync(helpers, `
import { createViewer, mesh, type DatasetConfig } from "galavi";
import { omeZarr } from "galavi/ome-zarr";

const zarrDescriptor = omeZarr("https://example.test/image.ome.zarr");
const meshDescriptor = mesh("https://example.test/mesh.obj");

// The helper results are exactly the DatasetConfigMap members — assignable
// both to the shared DatasetConfig union and to the exact member shape.
const asConfigs: DatasetConfig[] = [zarrDescriptor, meshDescriptor];
void asConfigs;
const exactZarr: { type: "ome-zarr"; source: string } = zarrDescriptor;
const exactMesh: { type: "mesh"; source: string } = meshDescriptor;
void [exactZarr, exactMesh];

// Straight into ViewerConfig.dataset — the target first-use form.
const viewer = await createViewer("#app", {
  dataset: omeZarr("https://example.test/image.ome.zarr"),
});
void viewer;

// @ts-expect-error — source is required
omeZarr();

// @ts-expect-error — source must be a string
omeZarr(42);

// @ts-expect-error — source must be a string
mesh(null);

// @ts-expect-error — descriptor helpers take no extra/runtime options
omeZarr("https://example.test/x.zarr", { fetch: () => {} });

// @ts-expect-error — extra/runtime fields are not part of the descriptor
const withRuntime: DatasetConfig = { type: "ome-zarr", source: "https://example.test/x", fetch: () => {} };
void withRuntime;
`);
  // The state schema surface (validateState / normalizeState + the portable
  // reference vocabulary) lives on the root entry; transport is plain JSON.
  const stateSnippet = join(app, "state-schema.ts");
  writeFileSync(stateSnippet, `
import {
  createViewer,
  normalizeState,
  validateState,
  type ChannelState,
  type CompositionReference,
  type JsonObject,
  type JsonValue,
  type State,
} from "galavi";

const camera: State["exploration"]["camera"] = {
  navMode: "orbit", projMode: "perspective", position: [0, 0, 1], target: [0, 0, 0],
};
const channel: ChannelState = { index: 0, label: "a", visible: true, color: "#00B0FF", contrast: [0, 1] };
const composition: CompositionReference = { type: "volume" };
const config: JsonObject = { stride: 2 };
const withConfig: CompositionReference = { ...composition, config };
void withConfig;
const json: JsonValue = { label: "µm", values: [0, 1] };
void json;

const viewer = await createViewer("#app", {
  dataset: { type: "mesh", source: "https://example.test/mesh.obj" },
});
// The portable state loop over the ONE unified State: snapshot -> JSON -> restore.
const snapshot: State = viewer.getState();
await viewer.setState(JSON.parse(JSON.stringify(snapshot)) as State);
const stop = viewer.subscribe((next: State) => { void next; });
stop();

// The scene-document surface: a portable State validates and normalizes;
// JSON round-trips are the transport.
const state = validateState({
  layers: [{ id: "l", type: "volume", data: { url: "https://example.test/x" } }],
  exploration: { camera },
  channels: [channel],
  composition,
  projection: "mip",
});
const normalized = normalizeState(JSON.parse(JSON.stringify(state)));
void normalized;

// @ts-expect-error — getState()/setState() are the state surface; there is no viewer.config
viewer.config;
`);
  if (!existsSync(TSC)) fail(`TypeScript not found at ${TSC} — run bun install first`);
  for (const file of [snippet, rootOnly, lowLevelSnippet, rejections, identity, plate, helpers, stateSnippet]) {
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
    "zarrita as a transitive runtime dependency, resolvable root + ome-zarr entries " +
    "(root side-effect-free, registration only in galavi/ome-zarr, " +
    "the state schema surface on the root entry with JSON as the transport), " +
    "single-identity declarations shared across entries, " +
    "mesh/omeZarr descriptor helpers (tree-shaking-safe registration), " +
    "and consumer-side typed dataset configs + portable viewer state",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(app, { recursive: true, force: true });
}
