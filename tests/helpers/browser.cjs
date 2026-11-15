const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

exports.browserExecutable = function browserExecutable() {
  if (process.env.LDFCL_TEST_BROWSER) {
    if (
      !path.isAbsolute(process.env.LDFCL_TEST_BROWSER) ||
      !fs.existsSync(process.env.LDFCL_TEST_BROWSER)
    )
      throw Error(
        "LDFCL_TEST_BROWSER must name an existing absolute browser executable",
      );
    return process.env.LDFCL_TEST_BROWSER;
  }
  const bases = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const candidates = [
    chromium.executablePath(),
    ...bases.flatMap((root) => [
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    ]),
  ];
  for (const directory of (process.env.PATH || "")
    .split(path.delimiter)
    .filter((p) => path.isAbsolute(p)))
    for (const executable of [
      "chromium",
      "chromium-browser",
      "google-chrome",
      "msedge.exe",
    ])
      candidates.push(path.join(directory, executable));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable)
    throw Error(
      "No Chromium browser found. Install Chromium/Edge or set LDFCL_TEST_BROWSER.",
    );
  return executable;
};
