"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const root = path.dirname(require.resolve("../package.json"));
const version = require("../package.json").version;
const dir = path.join(root, "release", version);
const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const required = (name, relative) => {
  const file = path.join(root, relative),
    report = read(file);
  assert.equal(report.passed, true, `${name} did not pass`);
  return { file, report };
};
const reports = {
  lighting: required(
    "Skin color output",
    "test-results/skin-lighting/after/report.json",
  ),
  packagedLighting: required(
    "Packaged skin color output",
    "test-results/skin-lighting/packaged/report.json",
  ),
  previewPerformance: required(
    "Preview drawing lifecycle",
    "test-results/skin-performance/report.json",
  ),
  package: required("ASAR integrity", `release/${version}/package-report.json`),
  source: required(
    "Independent source build",
    `release/${version}/source-report.json`,
  ),
  relocation: required(
    "Portable relocation",
    "test-results/portable-relocation-smoke.json",
  ),
  recovery: required(
    "Portable recovery",
    `test-results/${version}-recovery-updates-smoke.json`,
  ),
  modernUI: required(
    "Modern workspace",
    "test-results/modern-workspace/report.json",
  ),
  events: required(
    "Event/navigation",
    "test-results/ui-event-navigation/report.json",
  ),
  login: required(
    "Controlled device login",
    "test-results/device-login-smoke.json",
  ),
  startup: required("Startup recovery", "test-results/startup-smoke.json"),
};
const exe = path.join(dir, `LDFCL-${version}-Windows-x64.exe`);
const source = path.join(dir, `LDFCL-${version}-source.zip`);
const assets = [exe, source].map((file) => ({
  name: path.basename(file),
  bytes: fs.statSync(file).size,
  sha256: hash(file),
}));
assert.equal(reports.package.report.version, version);
assert.equal(reports.packagedLighting.report.applicationVersion, version);
assert.equal(
  reports.packagedLighting.report.asarSha256,
  reports.package.report.asarSha256,
);
assert.equal(reports.relocation.report.executable.sha256, assets[0].sha256);
assert.equal(reports.recovery.report.executableSha256, assets[0].sha256);
assert.equal(reports.source.report.archive.sha256, assets[1].sha256);
assert.equal(
  reports.package.report.asarSha256,
  hash(path.join(dir, "win-unpacked", "resources", "app.asar")),
);
const raw = fs.readFileSync(
  path.join(root, "test-results", "architecture-core-tests.log"),
);
const log = raw
  .toString(raw[0] === 0xff && raw[1] === 0xfe ? "utf16le" : "utf8")
  .replace(/\x1b\[[0-9;]*m/g, "");
const count = (name) => {
  const match = log.match(
    new RegExp(`(?:^|\\n)[^\\n]*?\\b${name}\\s+(\\d+)\\s*(?:\\r?\\n|$)`),
  );
  assert(match, `No actual test ${name} count in log`);
  return Number(match[1]);
};
const unitTests = {
  total: count("tests"),
  passed: count("pass"),
  failed: count("fail"),
  cancelled: count("cancelled"),
  skipped: count("skipped"),
};
assert.equal(unitTests.total, unitTests.passed);
assert.equal(unitTests.failed + unitTests.cancelled + unitTests.skipped, 0);
const evidence = {};
for (const [name, { file, report }] of Object.entries(reports)) {
  const copy = `${name}-report.json`;
  const destination = path.join(dir, copy);
  if (path.resolve(destination) !== path.resolve(file))
    fs.copyFileSync(file, destination);
  evidence[name] = {
    report: copy,
    sha256: hash(destination),
    passed: true,
    checks: report.checks?.length,
    pageErrors: report.pageErrors?.length,
  };
}
fs.copyFileSync(
  path.join(root, "test-results", "architecture-core-tests.log"),
  path.join(dir, "core-tests.log"),
);
const result = {
  schemaVersion: 2,
  passed: true,
  version,
  createdAt: new Date().toISOString(),
  sourceBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  sourceIdentity:
    "Source archive SHA-256 is the exact source snapshot; base commit may precede local refactor changes.",
  assets,
  unitTests,
  evidence,
  source: {
    archiveAudited: true,
    workspacePackages: reports.source.report.workspacePackages.map(
      (item) => item.name,
    ),
    independentWorkingDirectory: true,
    commands: reports.source.report.commands.map((item) => ({
      label: item.label,
      exitCode: item.exitCode,
    })),
  },
  portable: {
    normalStartups: reports.relocation.report.runs.length,
    relocations: reports.relocation.report.runs.length - 1,
    executableUnmodified: true,
    syntheticDataOnly: true,
  },
  limitations: [
    "Microsoft/Xbox/Minecraft 登录响应为受控测试；本轮没有真人授权、在线皮肤/披风操作或 Minecraft 游玩。",
    "最终 EXE 只检查启动、搬迁、旧实例恢复及更新状态，没有实际下载覆盖个人程序。",
    "没有本轮 4GB 低配真机性能验收；保留原 UI 动效、按需绘制、分页与事件合并。",
    "系统加密仍受 Windows 用户/设备保护；外部游戏根保留用户路径，单独移动时需重新定位。",
    "本地构建未签名；本报告不表示已更新 GitHub Latest。",
  ],
};
fs.writeFileSync(
  path.join(dir, "verification.json"),
  JSON.stringify(result, null, 2) + "\n",
);
const text = `# LDFCL ${version} 最终验证\n\n生成于 ${result.createdAt}。本地源码及运行包通过以下检查。\n\n| 检查 | 结果 |\n| --- | --- |\n| 预览像素颜色 | ${reports.lighting.report.samples.length} 个浏览器场景、${reports.packagedLighting.report.samples.length} 个成品场景，各验证两种模式 |\n| 预览绘制生命周期 | ${evidence.previewPerformance.checks} 组，首页和衣橱静止零绘制 |\n| 完整核心测试 | ${unitTests.passed}/${unitTests.total}，失败/跳过/取消均为 0 |\n| 真实 React 工作区 | ${evidence.modernUI.checks} 组交互、${reports.modernUI.report.screenshots.length} 张界面状态，无错误/溢出 |\n| 导航与事件 | ${evidence.events.checks} 组 |\n| 受控 Electron 登录 | ${evidence.login.checks} 组 |\n| Electron 启动恢复 | ${evidence.startup.checks} 个场景 |\n| 未修改便携 EXE | ${result.portable.normalStartups} 次正常启动/关闭、${result.portable.relocations} 次整目录搬迁 |\n| 旧实例/中文/更新状态 | ${evidence.recovery.checks} 组 |\n| ASAR 完整性 | ${reports.package.report.files} 个文件、${reports.package.report.blocks} 个完整性块 |\n| 源码归档 | ${reports.source.report.archiveAudit.files} 个文件，无账号/世界/依赖/编译输出 |\n| 独立重建 | 4 个 workspace 包，离线缓存安装，从无关目录构建及运行 CLI |\n\n精确源码由源码 ZIP 的 SHA-256 标识；详细证据及执行环境见同目录 verification.json 和各项报告。\n\n${result.limitations.map((line) => "- " + line).join("\n")}\n`;
fs.writeFileSync(path.join(dir, `VALIDATION-${version}.md`), text);
const checksumFiles = [
  exe,
  source,
  path.join(dir, "verification.json"),
  path.join(dir, `VALIDATION-${version}.md`),
  ...Object.values(evidence).map((item) => path.join(dir, item.report)),
];
fs.writeFileSync(
  path.join(dir, `SHA256SUMS-${version}.txt`),
  checksumFiles
    .map((file) => `${hash(file)}  ${path.basename(file)}`)
    .join("\n") + "\n",
);
console.log(
  JSON.stringify(
    {
      passed: true,
      version,
      unitTests,
      assets,
      report: path.join(dir, "verification.json"),
    },
    null,
    2,
  ),
);
