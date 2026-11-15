#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  root,
  packages,
  binary,
  cleanOutputs,
} = require("../build/workspace.cjs");
function run(entry, args = []) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const [command = "build", ...args] = process.argv.slice(2);
if (!["build", "build:main", "build:core", "test", "dist"].includes(command))
  throw Error(`Unknown project command: ${command}`);
const tsc = binary("typescript", "tsc");
if (command !== "build:core") cleanOutputs();
for (const pkg of packages()) {
  if (
    command === "build:core" &&
    !["@ldfcl/contracts", "@ldfcl/core"].includes(pkg.name)
  )
    continue;
  if (pkg.name === "@ldfcl/contracts") run(path.join(pkg.root, "build.cjs"));
  else run(tsc, ["-p", path.join(pkg.root, "tsconfig.json")]);
}
run(path.join(root, "scripts", "check-architecture.cjs"));
if (["build", "dist"].includes(command)) {
  run(tsc, ["-p", path.join(root, "tsconfig.json")]);
  run(binary("vite", "vite"), ["build", root]);
}
if (command === "test") {
  const files = fs
    .readdirSync(path.join(root, "tests"))
    .filter((file) => file.endsWith(".test.cjs"))
    .map((file) => path.join(root, "tests", file));
  const result = spawnSync(process.execPath, ["--test", ...files, ...args], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}
if (command === "dist")
  run(binary("electron-builder", "electron-builder"), [
    "--win",
    "portable",
    "--x64",
    ...args,
  ]);
