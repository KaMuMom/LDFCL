const fs = require("node:fs");
const path = require("node:path");

// TypeScript does not remove output for moved sources. Never ship an old copy
// of the business layer alongside the workspace core package.
const output = path.resolve(__dirname, "..", "dist-electron");
fs.rmSync(output, { recursive: true, force: true });
