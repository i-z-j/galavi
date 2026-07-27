/**
 * Pack assertion: the published npm artifact must contain the built bundle
 * and type declarations referenced by the `exports` map. Packs into a temp
 * dir and inspects the tarball's file list and manifest.
 *
 * Requires a prior `bun run build` (dist/ is not rebuilt here).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_FILES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/galavi.js",
  "package/dist/galavi.js.map",
  "package/dist/index.d.ts",
];

function fail(message) {
  console.error(`pack check FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync("dist/galavi.js") || !existsSync("dist/index.d.ts")) {
  fail("dist/ is missing or incomplete — run `bun run build` first");
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
  ];
  for (const [field, target] of entryPoints) {
    if (!target) fail(`manifest is missing ${field}`);
    const entry = `package/${target.replace(/^\.\//, "")}`;
    if (!listing.includes(entry)) fail(`${field} points at ${target}, absent from tarball`);
  }

  console.log(`pack check OK: ${filename} carries ${EXPECTED_FILES.length} expected files and a consistent exports map`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
