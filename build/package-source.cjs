// Explicit allowlist keeps local game data, credentials and dependencies out of source archives.
const fs = require("node:fs");
const path = require("node:path");
const AdmZip = require("adm-zip");
const root = path.resolve(__dirname, "..");
const zip = new AdmZip();
const files = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.electron.json",
  "vite.config.ts",
  "index.html",
  ".gitignore",
  "LICENSE",
  "README.md",
  "VALIDATION.md",
  "THIRD_PARTY_NOTICES.md",
  "CREDITS.md",
];
for (const file of files) zip.addLocalFile(path.join(root, file));
for (const directory of [
  "electron",
  "shared",
  "src",
  "public",
  "build",
  "tests",
  "docs",
])
  zip.addLocalFolder(path.join(root, directory), directory);
fs.mkdirSync(path.join(root, "release"), { recursive: true });
const output = path.join(
  root,
  "release",
  `LDFCL-${require("../package.json").version}-source.zip`,
);
zip.writeZip(output);
const entries = new AdmZip(output).getEntries();
if (
  entries.some((e) =>
    /(?:^|\/)(?:accounts\.json|launcher\.json|LDFCL-data|node_modules|\.git|\.env)(?:\/|$)/.test(
      e.entryName,
    ),
  )
)
  throw Error("Unexpected private data in source archive");
console.log(
  `Source archive verified: ${entries.length} entries, ${fs.statSync(output).size} bytes.`,
);
