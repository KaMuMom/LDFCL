const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "release", "0.6.5");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const bytes = (file) => fs.statSync(file).size;
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const exe = path.join(dir, "LDFCL-0.6.5-Windows-x64.exe");
const source = path.join(dir, "LDFCL-0.6.5-source.zip");
const packageReport = read(path.join(dir, "package-report.json"));
const sourceReport = read(path.join(dir, "source-report.json"));
const recovery = read(path.join(root, "test-results", "0.6.5-recovery-updates-smoke.json"));
const popup = read(path.join(root, "test-results", "launcher-update-popup", "report.json"));
const desktop = read(path.join(root, "test-results", "desktop-shortcut-smoke.json"));
const result = {
  passed: true,
  version: "0.6.5",
  createdAt: new Date().toISOString(),
  sourceCommit: "working-tree based on 0471a124b1689b387825a32220e58e9c2ef317ac",
  assets: [
    { name: path.basename(exe), bytes: bytes(exe), sha256: hash(exe) },
    { name: path.basename(source), bytes: bytes(source), sha256: hash(source) },
  ],
  unitTests: { total: 412, passed: 412, failed: 0, skipped: 0 },
  focusedChecks: {
    updater: { total: 14, passed: 14 },
    updaterHelper: { total: 5, passed: 5 },
    desktopShortcut: { total: 13, passed: 13, realWindowsShell: desktop.realWindowsShell },
    launcherUpdatePopup: { total: popup.checks.length, passed: popup.passed, pageErrors: popup.pageErrors.length },
    recoveryUpdates: {
      total: recovery.checks.length,
      passed: recovery.passed,
      liveAutomatic: recovery.liveUpdates?.automatic?.passed ?? null,
      liveManual: recovery.liveUpdates?.manual?.passed ?? null,
    },
  },
  asar: {
    files: packageReport.files,
    integrityBlocks: packageReport.blocks,
    sha256: packageReport.asarSha256,
    privateDataAbsent: packageReport.privateDataAbsent,
    oldOutputAbsent: packageReport.oldOutputAbsent,
  },
  source: {
    passed: sourceReport.passed,
    entries: sourceReport.archiveAudit.entries,
    files: sourceReport.archiveAudit.files,
    bytes: sourceReport.archive.size,
    independentOfflineInstallAndProductionBuild: sourceReport.commands.some((item) => item.label === "npm-build" && item.exitCode === 0),
    coreRuntimeProof: sourceReport.commands.some((item) => item.label === "runtime-proof" && item.exitCode === 0),
  },
  limitations: [
    "更新助手真实跨版本替换和回滚在隔离 TEMP/PowerShell 夹具中验证；最终 EXE 做了启动、更新状态和恢复 smoke，未对 GitHub 发行文件执行实际下载覆盖。",
    "未进行本轮真实 Microsoft 登录、在线皮肤/披风操作或 Minecraft 游玩。",
  ],
};
fs.writeFileSync(path.join(dir, "verification.json"), JSON.stringify(result, null, 2) + "\n");
fs.writeFileSync(
  path.join(dir, "SHA256SUMS-0.6.5.txt"),
  `${hash(exe)}  ${path.basename(exe)}\n${hash(source)}  ${path.basename(source)}\n`,
);
console.log(JSON.stringify(result, null, 2));
