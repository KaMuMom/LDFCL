const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Use Electron's real Windows .lnk APIs against an isolated TEMP desktop only.
// No user profile, game installation, real desktop link or network is modified.
(async () => {
  if (process.platform !== "win32") {
    console.log("Windows-only desktop shortcut smoke skipped");
    return;
  }
  const project = path.resolve(__dirname, "..");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-real-shortcut-"));
  const runner = path.join(root, "shortcut-runner.cjs");
  const report = path.join(root, "report.json");
  const helper = require.resolve("@ldfcl/desktop/desktop-shortcut");
  const source = `
const { app, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { ensureDesktopShortcut, DESKTOP_SHORTCUT_APP_ID } = require(${JSON.stringify(helper)});
const root = ${JSON.stringify(root)};
const reportPath = ${JSON.stringify(report)};
app.whenReady().then(async () => {
  const realDesktop = app.getPath("desktop");
  const desktopDirectory = path.join(root, "OneDrive - 中文重定向桌面", "Desktop");
  const install = path.join(root, "中文 空格 便携安装");
  const otherInstall = path.join(root, "另一个安装");
  for (const directory of [desktopDirectory, install, otherInstall]) await fs.mkdir(directory, { recursive: true });
  const executablePath = path.join(install, "LDFCL-0.6.4-Windows-x64.exe");
  await fs.copyFile(path.join(process.env.SystemRoot, "System32", "where.exe"), executablePath);
  await fs.mkdir(path.join(install, ".minecraft"));
  await fs.mkdir(path.join(install, "LDFCL-data"));
  await fs.writeFile(path.join(install, ".minecraft", "sentinel"), "game data retained");
  await fs.writeFile(path.join(install, "LDFCL-data", "sentinel"), "account/config retained");
  const within = (parent, file) => { const relative = path.relative(parent, file); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
  const guard = (file) => {
    assert(!within(realDesktop, file), "The smoke must never touch the personal desktop");
    assert(within(root, file) || (within(os.tmpdir(), file) && path.basename(path.dirname(file)).startsWith("LDFCL-link-")), "Unexpected shortcut path outside TEMP fixture");
  };
  const host = {
    readShortcutLink(file) { guard(file); return shell.readShortcutLink(file); },
    writeShortcutLink(file, operation, details) { guard(file); return shell.writeShortcutLink(file, operation, details); },
  };
  const shortcut = (name, target) => {
    const file = path.join(desktopDirectory, name);
    assert(host.writeShortcutLink(file, "create", { target, cwd: path.dirname(target), args: "", icon: target, iconIndex: 0, appUserModelId: DESKTOP_SHORTCUT_APP_ID }), "Create real fixture .lnk");
    return file;
  };
  const oldTarget = path.join(install, "LDFCL-0.6.3-Windows-x64.exe");
  const duplicate = shortcut("LDFCL-0.6.3-Windows-x64.lnk", oldTarget);
  const implicitShortcut = (name, target, cwd) => {
    const file = path.join(desktopDirectory, name);
    assert(host.writeShortcutLink(file, "create", { target, cwd, args: "" }));
    assert.equal(host.readShortcutLink(file).icon, "", "Windows default icon reads back empty");
    assert.equal(host.readShortcutLink(file).iconIndex, 0);
    return file;
  };
  const chinese = implicitShortcut("LDFCL.exe - 快捷方式.lnk", executablePath, install);
  const chineseVersion = implicitShortcut("LDFCL-0.6.4-Windows-x64.exe - 快捷方式.lnk", executablePath, "");
  const english = implicitShortcut("LDFCL.exe - Shortcut.lnk", oldTarget, install);
  const oldBlankCwd = implicitShortcut("LDFCL-0.6.3-Windows-x64.exe - Shortcut.lnk", oldTarget, "");
  const customIcon = path.join(desktopDirectory, "LDFCL.exe - Shortcut (2).lnk");
  assert(host.writeShortcutLink(customIcon, "create", { target: executablePath, cwd: install, args: "", icon: path.join(otherInstall, "notes.exe"), iconIndex: 0 }));
  const unrelated = shortcut("Other Application.lnk", path.join(otherInstall, "notes.exe"));
  const other = shortcut("LDFCL-0.6.2-Windows-x64.lnk", path.join(otherInstall, "LDFCL-0.6.2-Windows-x64.exe"));
  const options = { platform: "win32", desktopDirectory, executablePath, shell: host };
  const created = await ensureDesktopShortcut(options);
  assert.equal(created.status, "created", JSON.stringify(created));
  assert.deepEqual(created.removed.sort(), [duplicate, chinese, chineseVersion, english].sort());
  assert((await fs.stat(oldBlankCwd)).isFile(), "Older target with blank cwd is preserved");
  assert((await fs.stat(customIcon)).isFile(), "Explicit different icon is preserved");
  const fixed = path.join(desktopDirectory, "LDFCL.lnk");
  const bytes = await fs.readFile(fixed);
  assert.equal(bytes.readUInt32LE(0), 0x4c, "Actual binary Shell Link header");
  const details = host.readShortcutLink(fixed);
  assert.equal(details.target, executablePath);
  assert.equal(details.cwd, install);
  assert.equal(details.icon, executablePath);
  assert.equal(details.iconIndex, 0);
  assert.equal(details.appUserModelId, DESKTOP_SHORTCUT_APP_ID);
  const same = await ensureDesktopShortcut(options);
  assert.equal(same.status, "unchanged", JSON.stringify(same));
  assert.deepEqual(await fs.readFile(fixed), bytes, "Idempotent startup keeps .lnk bytes unchanged");
  assert(host.writeShortcutLink(fixed, "replace", { target: oldTarget, cwd: install, args: "" }));
  assert.equal(host.readShortcutLink(fixed).icon, "");
  const legacyImplicit = await ensureDesktopShortcut(options);
  assert.equal(legacyImplicit.status, "updated", JSON.stringify(legacyImplicit));
  assert.equal(host.readShortcutLink(fixed).target, executablePath);
  assert.equal(host.readShortcutLink(fixed).icon, executablePath);
  const nextExecutable = path.join(install, "LDFCL-0.6.5-Windows-x64.exe");
  await fs.copyFile(executablePath, nextExecutable);
  const updated = await ensureDesktopShortcut({ ...options, executablePath: nextExecutable });
  assert.equal(updated.status, "updated", JSON.stringify(updated));
  assert.equal(host.readShortcutLink(fixed).target, nextExecutable);
  assert.equal(host.readShortcutLink(fixed).icon, nextExecutable);
  assert.equal(host.readShortcutLink(fixed).cwd, install);
  await fs.unlink(fixed);
  shortcut("LDFCL.lnk", path.join(otherInstall, "LDFCL.exe"));
  const occupied = await fs.readFile(fixed);
  const conflict = await ensureDesktopShortcut({ ...options, executablePath: nextExecutable });
  assert.equal(conflict.status, "conflict", JSON.stringify(conflict));
  assert.deepEqual(await fs.readFile(fixed), occupied, "Unrelated installation's link remains unchanged");
  assert((await fs.stat(other)).isFile());
  assert((await fs.stat(unrelated)).isFile());
  assert.equal(await fs.readFile(path.join(install, ".minecraft", "sentinel"), "utf8"), "game data retained");
  assert.equal(await fs.readFile(path.join(install, "LDFCL-data", "sentinel"), "utf8"), "account/config retained");
  assert.equal(await fs.readFile(executablePath, "base64"), await fs.readFile(nextExecutable, "base64"));
  await fs.writeFile(reportPath, JSON.stringify({ passed: true, realWindowsShell: true, redirectedTempDesktop: desktopDirectory !== realDesktop, binaryLinkHeader: "0x4c", created: created.status, repeated: same.status, updated: updated.status, occupied: conflict.status, confirmedDuplicateRemoved: created.removed.length, chineseEnglishSendToDesktopMigrated: true, implicitIconReadsEmpty: true, oldBlankCwdAndExplicitDifferentIconPreserved: true, canonicalOldImplicitIconMigrated: legacyImplicit.status === "updated", gameAndAccountDataRetained: true, personalDesktopTouched: false }, null, 2));
  app.exit(0);
}).catch(async error => { await fs.writeFile(reportPath, JSON.stringify({ passed: false, error: error.stack || String(error) })); app.exit(1); });
`;
  await fs.writeFile(runner, source);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    child = spawn(require("electron"), [runner], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (bytes) => (output += bytes));
    child.stderr.on("data", (bytes) => (output += bytes));
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(Error("Shortcut smoke timed out"));
      }, 30000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    const result = JSON.parse(await fs.readFile(report, "utf8"));
    assert.equal(exitCode, 0, JSON.stringify({ result, output }));
    assert(result.passed);
    const outputDirectory = path.join(project, "test-results");
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(
      path.join(outputDirectory, "desktop-shortcut-smoke.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (child && child.exitCode === null) child.kill();
    // root is the exact mkdtemp fixture, with no junctions or user paths inside.
    assert(
      path.dirname(root) === os.tmpdir() &&
        path.basename(root).startsWith("LDFCL-real-shortcut-"),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
