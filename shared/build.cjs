"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.dirname(require.resolve("./package.json"));
const compiler = require.resolve("typescript/bin/tsc");
for (const extra of [
  [],
  [
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--outDir",
    "dist/esm",
    "--declaration",
    "false",
  ],
]) {
  const result = spawnSync(
    process.execPath,
    [compiler, "-p", path.join(root, "tsconfig.json"), ...extra],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
fs.writeFileSync(
  path.join(root, "dist/esm/package.json"),
  JSON.stringify({ type: "module" }) + "\n",
);
