// Audit the built application bytes, including every ASAR integrity block.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const asar = require("@electron/asar");
const root = path.resolve(__dirname, "..");
assert(
  process.argv.length <= 4 &&
    (process.argv[3] === undefined || path.isAbsolute(process.argv[3])),
  "Usage: node scripts/verify-package.cjs [application-directory] [absolute-report.json]",
);
const directory = path.resolve(
  process.argv[2] || path.join(root, "release/p0-p6/win-unpacked"),
);
const reportFile =
  process.argv[3] || path.join(root, "test-results/p0-p6-package-audit.json");
const archive = path.join(directory, "resources/app.asar");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// @electron/asar traverses directories with path.sep, including on Windows.
const archivePath = (file) => path.normalize(file);
const extract = (file) => asar.extractFile(archive, archivePath(file));
let files = 0,
  blocks = 0;
const entries = asar
  .listPackage(archive)
  .map((file) => file.replace(/^[/\\]/, "").replaceAll("\\", "/"));
for (const file of entries) {
  const stat = asar.statFile(archive, archivePath(file), false);
  if (stat.files || stat.link || stat.unpacked) continue;
  const data = extract(file);
  assert(
    stat.integrity && stat.integrity.algorithm === "SHA256",
    `missing integrity ${file}`,
  );
  assert.equal(sha(data), stat.integrity.hash, `file digest ${file}`);
  for (let index = 0; index < stat.integrity.blocks.length; index++) {
    const start = index * stat.integrity.blockSize;
    assert.equal(
      sha(data.subarray(start, start + stat.integrity.blockSize)),
      stat.integrity.blocks[index],
      `block digest ${file}:${index}`,
    );
    blocks++;
  }
  files++;
}
const compared = [];
const omittedDeclarations = [];
const entrySet = new Set(entries);
function compareTree(localDirectory, prefix) {
  for (const entry of fs.readdirSync(localDirectory, { withFileTypes: true })) {
    const local = path.join(localDirectory, entry.name),
      target = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) compareTree(local, target);
    else if (entry.isFile()) {
      // electron-builder excludes declarations from runtime packages by default.
      if (target.endsWith(".d.ts") && !entrySet.has(target)) {
        omittedDeclarations.push(target);
        continue;
      }
      assert.deepEqual(
        extract(target),
        fs.readFileSync(local),
        `workspace/package mismatch ${target}`,
      );
      compared.push(target);
    }
  }
}
compareTree(path.join(root, "dist"), "dist");
compareTree(path.join(root, "dist-electron"), "dist-electron");
compareTree(path.join(root, "core/dist"), "node_modules/@ldfcl/core/dist");
assert(
  !entries.some((file) =>
    /^(?:dist-electron\/electron\/services|dist-electron\/core)(?:\/|$)/.test(
      file,
    ),
  ),
  "old business output bundled",
);
assert(
  !entries.some((file) =>
    /(?:^|\/)(?:accounts\.json|launcher\.json|LDFCL-data|\.minecraft|ai-secrets\.json|\.env)(?:\/|$)/i.test(
      file,
    ),
  ),
  "private data bundled",
);
const pkg = JSON.parse(extract("package.json"));
const core = JSON.parse(extract("node_modules/@ldfcl/core/package.json"));
assert.equal(pkg.version, require("../package.json").version);
assert.equal(core.version, pkg.version);
const report = {
  passed: true,
  archive,
  version: pkg.version,
  files,
  blocks,
  comparedFiles: compared.length,
  omittedDeclarations,
  asarSha256: sha(fs.readFileSync(archive)),
  oldOutputAbsent: true,
  privateDataAbsent: true,
};
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
