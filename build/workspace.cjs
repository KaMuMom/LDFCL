"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.dirname(require.resolve("../package.json"));
const manifest = () =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packages = () =>
  manifest().workspaces.map((directory) => ({
    directory,
    root: path.join(root, directory),
    ...JSON.parse(
      fs.readFileSync(path.join(root, directory, "package.json"), "utf8"),
    ),
  }));
function binary(name, command) {
  const file = require.resolve(`${name}/package.json`);
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[command];
  if (!entry) throw Error(`No ${command} command in ${name}`);
  return path.resolve(path.dirname(file), entry);
}
function cleanOutputs() {
  for (const relative of [
    "dist-electron",
    ...packages().map((p) => `${p.directory}/dist`),
  ]) {
    const target = path.resolve(root, relative);
    const within = path.relative(root, target);
    if (!within || within.startsWith("..") || path.isAbsolute(within))
      throw Error("Invalid build output");
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
      throw Error(`Refusing linked output: ${relative}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
}
module.exports = { root, manifest, packages, binary, cleanOutputs };
