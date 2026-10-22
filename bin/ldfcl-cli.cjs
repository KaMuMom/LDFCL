#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const entry = path.join(__dirname, "..", "dist-electron", "cli", "main.js");
if (!fs.existsSync(entry)) {
  process.stderr.write("LDFCL CLI is not built. Run npm run build first.\n");
  process.exitCode = 1;
} else {
  require(entry)
    .runCli(process.argv.slice(2))
    .then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        process.stderr.write(
          `LDFCL CLI: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
}
