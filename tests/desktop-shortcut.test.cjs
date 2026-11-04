const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ensureDesktopShortcut,
  DESKTOP_SHORTCUT_APP_ID,
} = require("../dist-electron/electron/desktop-shortcut.js");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-shortcut-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const desktopDirectory = path.join(root, "OneDrive - 重定向桌面", "Desktop");
  const install = path.join(root, "我的 便携程序");
  await fs.mkdir(desktopDirectory, { recursive: true });
  await fs.mkdir(install, { recursive: true });
  const executablePath = path.join(install, "LDFCL-0.6.4-Windows-x64.exe");
  await fs.writeFile(executablePath, "MZ controlled fixture - do not execute");
  await fs.mkdir(path.join(install, ".minecraft"));
  await fs.writeFile(path.join(install, ".minecraft", "sentinel"), "game data");
  const writes = [];
  const shell = {
    readShortcutLink(file) {
      return JSON.parse(syncFs.readFileSync(file, "utf8"));
    },
    writeShortcutLink(file, operation, details) {
      writes.push({ file, operation, details });
      syncFs.writeFileSync(file, JSON.stringify(details));
      return true;
    },
  };
  return {
    root,
    install,
    writes,
    shell,
    desktopDirectory,
    executablePath,
    fixed: path.join(desktopDirectory, "LDFCL.lnk"),
    options: { platform: "win32", desktopDirectory, executablePath, shell },
    details(target = executablePath, extra = {}) {
      return {
        target,
        cwd: path.dirname(target),
        args: "",
        icon: target,
        iconIndex: 0,
        ...extra,
      };
    },
    async link(name, details) {
      const file = path.join(desktopDirectory, name);
      await fs.writeFile(file, JSON.stringify(details));
      return file;
    },
  };
}

test("desktop link uses supplied redirected desktop and the outer portable EXE, idempotently", async (t) => {
  const f = await fixture(t);
  const created = await ensureDesktopShortcut(f.options);
  assert.equal(created.status, "created");
  assert.equal(created.shortcutPath, f.fixed);
  const details = f.shell.readShortcutLink(f.fixed);
  assert.deepEqual(details, {
    ...f.details(),
    description: "LDFCL Minecraft 启动器",
    appUserModelId: DESKTOP_SHORTCUT_APP_ID,
  });
  assert.equal(f.writes.length, 1);
  assert.equal((await ensureDesktopShortcut(f.options)).status, "unchanged");
  assert.equal(
    f.writes.length,
    1,
    "unchanged startup does not rewrite the link",
  );
  assert.deepEqual(await fs.readdir(f.desktopDirectory), ["LDFCL.lnk"]);
  assert.equal(
    await fs.readFile(f.executablePath, "utf8"),
    "MZ controlled fixture - do not execute",
  );
  assert.equal(
    await fs.readFile(path.join(f.install, ".minecraft", "sentinel"), "utf8"),
    "game data",
  );
});

test("fixed same-install shortcut repairs extracted icon/cwd without changing its name", async (t) => {
  const f = await fixture(t);
  await f.link(
    "LDFCL.lnk",
    f.details(f.executablePath, {
      cwd: path.join(f.root, "extract"),
      icon: path.join(f.root, "extract", "LDFCL.exe"),
    }),
  );
  assert.equal((await ensureDesktopShortcut(f.options)).status, "updated");
  assert.equal(f.shell.readShortcutLink(f.fixed).icon, f.executablePath);
  assert.equal(f.shell.readShortcutLink(f.fixed).cwd, f.install);
  assert.deepEqual(await fs.readdir(f.desktopDirectory), ["LDFCL.lnk"]);
});

test("migrates strict same-directory historical targets and deletes only confirmed duplicates", async (t) => {
  const f = await fixture(t);
  const old = path.join(f.install, "LDFCL-0.6.3-Windows-x64.exe");
  // The historical EXE may already have been removed during a portable update.
  await f.link("LDFCL.lnk", f.details(old));
  const duplicate = await f.link("LDFCL-0.6.3-Windows-x64.lnk", f.details(old));
  const numbered = await f.link("LDFCL (2).lnk", f.details());
  const otherInstall = await f.link(
    "LDFCL-0.6.2-Windows-x64.lnk",
    f.details(
      path.join(f.root, "other-install", "LDFCL-0.6.2-Windows-x64.exe"),
    ),
  );
  const otherProgram = await f.link(
    "Notes.lnk",
    f.details(path.join(f.install, "notes.exe")),
  );
  const customName = await f.link("My Minecraft.lnk", f.details());
  const result = await ensureDesktopShortcut(f.options);
  assert.equal(result.status, "updated");
  assert.deepEqual(result.removed.sort(), [duplicate, numbered].sort());
  for (const file of [otherInstall, otherProgram, customName])
    assert((await fs.stat(file)).isFile());
  assert.equal(f.shell.readShortcutLink(f.fixed).target, f.executablePath);
});

test("unrelated fixed shortcut is a conflict and prevents all writes and cleanup", async (t) => {
  const f = await fixture(t);
  await f.link("LDFCL.lnk", f.details(path.join(f.root, "other-app.exe")));
  const duplicate = await f.link("LDFCL (2).lnk", f.details());
  const before = await fs.readFile(f.fixed);
  const result = await ensureDesktopShortcut(f.options);
  assert.equal(result.status, "conflict");
  assert.match(result.message, /已保留/);
  assert.deepEqual(await fs.readFile(f.fixed), before);
  assert((await fs.stat(duplicate)).isFile());
  assert.equal(f.writes.length, 0);
});

test("unreadable fixed link or same-named directory is preserved", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.fixed, "unrecognized link data");
  assert.equal((await ensureDesktopShortcut(f.options)).status, "conflict");
  assert.equal(await fs.readFile(f.fixed, "utf8"), "unrecognized link data");
  await fs.unlink(f.fixed);
  await fs.mkdir(f.fixed);
  assert.equal((await ensureDesktopShortcut(f.options)).status, "conflict");
  assert((await fs.stat(f.fixed)).isDirectory());
  assert.equal(f.writes.length, 0);
});

test("cleanup retains suspicious cwd/icon/args/app-id and non-LDFCL executable targets", async (t) => {
  const f = await fixture(t);
  const cases = [
    f.details(f.executablePath, { cwd: path.join(f.root, "different") }),
    f.details(f.executablePath, {
      icon: path.join(f.install, "different.exe"),
    }),
    f.details(f.executablePath, { args: "--user-script" }),
    f.details(f.executablePath, { appUserModelId: "other.program" }),
    f.details(path.join(f.install, "NotLDFCL-0.6.3-Windows-x64.exe")),
    f.details(f.executablePath, { iconIndex: 9 }),
    f.details(path.join(f.install, "LDFCL-0.6.3-Windows-x64.exe"), { cwd: "" }),
  ];
  const files = [];
  for (let index = 0; index < cases.length; index++)
    files.push(await f.link(`LDFCL (${index + 2}).lnk`, cases[index]));
  const result = await ensureDesktopShortcut(f.options);
  assert.equal(result.status, "created");
  assert.deepEqual(result.removed, []);
  for (const file of files) assert((await fs.stat(file)).isFile());
});

test("Windows Chinese/English Send to Desktop names and implicit icons migrate safely", async (t) => {
  const f = await fixture(t);
  const oldTarget = path.join(f.install, "LDFCL-0.6.3-Windows-x64.exe");
  await f.link("LDFCL.lnk", f.details(oldTarget, { icon: "" }));
  const links = [
    ["LDFCL.exe - 快捷方式.lnk", f.details(f.executablePath, { icon: "" })],
    [
      "LDFCL-0.6.4-Windows-x64.exe - 快捷方式.lnk",
      f.details(f.executablePath, { icon: "", cwd: "" }),
    ],
    [
      "LDFCL.exe - Shortcut.lnk",
      f.details(f.executablePath, { icon: undefined, cwd: undefined }),
    ],
    [
      "LDFCL-0.6.3-Windows-x64 - Shortcut (2).lnk",
      f.details(oldTarget, { icon: "" }),
    ],
    [
      "LDFCL.exe - 快捷方式 (3).lnk",
      f.details(f.executablePath, { icon: "", cwd: "" }),
    ],
  ];
  const files = [];
  for (const [name, details] of links) files.push(await f.link(name, details));
  const result = await ensureDesktopShortcut(f.options);
  assert.equal(result.status, "updated");
  assert.deepEqual(result.removed.sort(), files.sort());
  assert.deepEqual(await fs.readdir(f.desktopDirectory), ["LDFCL.lnk"]);
  assert.equal(f.shell.readShortcutLink(f.fixed).target, f.executablePath);
  assert.equal(f.shell.readShortcutLink(f.fixed).icon, f.executablePath);
});

test("Send to Desktop naming cannot bypass explicit metadata or installation boundaries", async (t) => {
  const f = await fixture(t);
  const oldTarget = path.join(f.install, "LDFCL-0.6.3-Windows-x64.exe");
  const cases = [
    f.details(f.executablePath, {
      icon: path.join(f.install, "custom.ico"),
      cwd: "",
    }),
    f.details(f.executablePath, {
      icon: "",
      cwd: path.join(f.root, "other-cwd"),
    }),
    f.details(oldTarget, { icon: "", cwd: "" }),
    f.details(path.join(f.root, "other-install", "LDFCL.exe"), {
      icon: "",
      cwd: "",
    }),
    f.details(f.executablePath, { icon: "", args: "--custom" }),
    f.details(f.executablePath, { icon: "", iconIndex: 5 }),
    f.details(f.executablePath, { icon: "", appUserModelId: "other.app" }),
  ];
  const files = [];
  for (let index = 0; index < cases.length; index++)
    files.push(
      await f.link(`LDFCL.exe - Shortcut (${index + 2}).lnk`, cases[index]),
    );
  const result = await ensureDesktopShortcut(f.options);
  assert.equal(result.status, "created");
  assert.deepEqual(result.removed, []);
  for (const file of files) assert((await fs.stat(file)).isFile());
});

test("canonical shortcut for another installation or with launch arguments is not rewritten", async (t) => {
  const f = await fixture(t);
  for (const details of [
    f.details(path.join(f.root, "another", "LDFCL-0.6.4-Windows-x64.exe")),
    f.details(f.executablePath, { args: "custom" }),
    f.details(f.executablePath, { appUserModelId: "someone.else" }),
  ]) {
    await f.link("LDFCL.lnk", details);
    assert.equal((await ensureDesktopShortcut(f.options)).status, "conflict");
    assert.deepEqual(f.shell.readShortcutLink(f.fixed), details);
  }
  assert.equal(f.writes.length, 0);
});

test("unsupported and missing/relative executable paths never write", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await ensureDesktopShortcut({ ...f.options, platform: "linux" })).status,
    "unsupported",
  );
  for (const executablePath of [
    "relative.exe",
    path.join(f.install, "missing.exe"),
    f.install,
  ])
    assert.equal(
      (await ensureDesktopShortcut({ ...f.options, executablePath })).status,
      "invalid-executable",
    );
  assert.deepEqual(await fs.readdir(f.desktopDirectory), []);
  assert.equal(f.writes.length, 0);
});

test("write and verification failures keep legacy links instead of partially cleaning them", async (t) => {
  const f = await fixture(t);
  const duplicate = await f.link("LDFCL (2).lnk", f.details());
  f.shell.writeShortcutLink = () => false;
  assert.equal((await ensureDesktopShortcut(f.options)).status, "failed");
  assert((await fs.stat(duplicate)).isFile());
  f.shell.writeShortcutLink = (file, _operation, details) => {
    syncFs.writeFileSync(
      file,
      JSON.stringify({ ...details, target: "wrong.exe" }),
    );
    return true;
  };
  assert.equal((await ensureDesktopShortcut(f.options)).status, "failed");
  assert((await fs.stat(duplicate)).isFile());
});

test("a concurrent unrelated fixed link wins exclusive publication and stays byte-for-byte intact", async (t) => {
  const f = await fixture(t);
  const original = f.shell.writeShortcutLink;
  const collision = "another application created this concurrently";
  f.shell.writeShortcutLink = (...args) => {
    const written = original(...args);
    syncFs.writeFileSync(f.fixed, collision);
    return written;
  };
  const result = await ensureDesktopShortcut(f.options);
  assert.equal(result.status, "conflict");
  assert.equal(await fs.readFile(f.fixed, "utf8"), collision);
  assert.deepEqual(await fs.readdir(f.desktopDirectory), ["LDFCL.lnk"]);
});

test("duplicate retargeted during cleanup is preserved", async (t) => {
  const f = await fixture(t);
  const duplicate = await f.link("LDFCL (2).lnk", f.details());
  const original = f.shell.readShortcutLink;
  let duplicateReads = 0;
  f.shell.readShortcutLink = (file) => {
    if (file === duplicate && ++duplicateReads === 2)
      syncFs.writeFileSync(
        file,
        JSON.stringify(f.details(path.join(f.root, "other.exe"))),
      );
    return original(file);
  };
  const result = await ensureDesktopShortcut(f.options);
  assert.equal(result.status, "created");
  assert.deepEqual(result.removed, []);
  assert((await fs.stat(duplicate)).isFile());
});
