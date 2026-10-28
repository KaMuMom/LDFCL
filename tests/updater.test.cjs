const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  stableVersion,
  newerVersion,
  parseRelease,
  checksumFor,
  downloadUpdate,
  LauncherUpdater,
  UPDATE_HELPER,
} = require("../dist-electron/electron/updater.js");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const payload = Buffer.from("MZ controlled update payload");
function releaseRaw(extra = {}) {
  return {
    tag_name: "v0.6.3",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "LDFCL-0.6.3-Windows-x64.exe",
        browser_download_url:
          "https://github.com/KaMuMom/LDFCL/releases/download/v0.6.3/LDFCL-0.6.3-Windows-x64.exe",
        size: payload.length,
        digest: `sha256:${hash(payload)}`,
      },
    ],
    ...extra,
  };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-update-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function mockHttps(t, bytes = payload, options = {}) {
  t.mock.method(https, "get", (_url, _options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => req.emit("error", error);
    process.nextTick(() => {
      const stream = new PassThrough();
      stream.statusCode = options.status || 200;
      stream.headers = options.headers || {};
      callback(stream);
      stream.end(bytes);
    });
    return req;
  });
}

test("update version ordering is numeric and accepts stable releases only", () => {
  assert.equal(newerVersion("0.6.10", "0.6.9"), true);
  assert.equal(newerVersion("1.0.0", "0.99.99"), true);
  assert.equal(newerVersion("0.6.2", "0.6.3"), false);
  assert.equal(newerVersion("v0.6.3", "0.6.3"), false);
  for (const value of ["0.6.3-beta.1", "0.6", "0.6.3;calc", "0.6.3+build"])
    assert.equal(stableVersion(value), undefined);
});
test("GitHub metadata requires stable exact repository asset and SHA256", () => {
  assert.equal(parseRelease(releaseRaw()).version, "0.6.3");
  assert.throws(
    () => parseRelease(releaseRaw({ prerelease: true })),
    /正式发行版/,
  );
  assert.throws(() => parseRelease(releaseRaw({ draft: true })), /正式发行版/);
  const bad = releaseRaw();
  bad.assets[0].browser_download_url = "https://example.org/update.exe";
  assert.throws(() => parseRelease(bad), /地址无效/);
  const missing = releaseRaw();
  delete missing.assets[0].digest;
  assert.throws(() => parseRelease(missing), /SHA-256/);
  const sums = {
    name: "SHA256SUMS-0.6.3.txt",
    browser_download_url:
      "https://github.com/KaMuMom/LDFCL/releases/download/v0.6.3/SHA256SUMS-0.6.3.txt",
    size: 200,
  };
  missing.assets.push(sums);
  const release = parseRelease(missing);
  assert.equal(
    checksumFor(release, `${hash(payload)}  ${release.asset.name}\n`),
    hash(payload),
  );
  assert.throws(
    () => checksumFor(release, `${hash(payload)}  other.exe`),
    /对应更新文件/,
  );
});
test("update download validates bytes, Windows header and SHA256 before publishing", async (t) => {
  const root = await temporary(t);
  mockHttps(t);
  const target = path.join(root, "update.exe");
  const progress = [];
  await downloadUpdate(
    parseRelease(releaseRaw()),
    target,
    hash(payload),
    (...value) => progress.push(value),
  );
  assert.deepEqual(await fs.readFile(target), payload);
  assert.deepEqual(progress.at(-1), [payload.length, payload.length]);
});
test("update download never deletes an existing destination after exclusive-open failure", async (t) => {
  const root = await temporary(t);
  const target = path.join(root, "existing.exe");
  await fs.writeFile(target, "keep");
  await assert.rejects(
    downloadUpdate(parseRelease(releaseRaw()), target, hash(payload), () => {}),
    /EEXIST/,
  );
  assert.equal(await fs.readFile(target, "utf8"), "keep");
});
test("corrupt, oversized and non-executable updates are removed", async (t) => {
  const root = await temporary(t);
  for (const [name, bytes, expected] of [
    ["hash", payload, "0".repeat(64)],
    ["size", Buffer.concat([payload, payload]), hash(payload)],
    [
      "header",
      Buffer.from("XX controlled update payload"),
      hash(Buffer.from("XX controlled update payload")),
    ],
  ]) {
    await t.test(name, async (child) => {
      mockHttps(child, bytes);
      const target = path.join(root, `${name}.exe`);
      await assert.rejects(
        downloadUpdate(parseRelease(releaseRaw()), target, expected, () => {}),
        /校验失败|大小不符|Windows/,
      );
      await assert.rejects(fs.access(target), /ENOENT/);
    });
  }
});
test("update redirect refuses untrusted download hosts", async (t) => {
  const root = await temporary(t);
  mockHttps(t, Buffer.alloc(0), {
    status: 302,
    headers: { location: "https://untrusted.example/update.exe" },
  });
  await assert.rejects(
    downloadUpdate(
      parseRelease(releaseRaw()),
      path.join(root, "update.exe"),
      hash(payload),
      () => {},
    ),
    /地址不受支持/,
  );
});
test("startup update errors remain local state and checks deduplicate", async () => {
  let calls = 0;
  let complete;
  const updater = new LauncherUpdater({
    currentVersion: "0.6.2",
    emit() {},
    canInstall: async () => {},
    quit() {},
    fetchText: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const first = updater.check(),
    second = updater.check();
  assert.equal(first, second);
  assert.equal(calls, 1);
  complete(JSON.stringify(releaseRaw()));
  assert.equal((await first).status, "available");
  const unavailable = new LauncherUpdater({
    currentVersion: "0.6.2",
    emit() {},
    canInstall: async () => {},
    quit() {},
    fetchText: async () => {
      throw Error("network unavailable");
    },
  });
  assert.equal((await unavailable.check()).status, "error");
});
test("portable updater downloads, checks install guard, then starts replacement with separate path arguments", async (t) => {
  const root = await temporary(t),
    executable = path.join(root, "中文 ' $ [space] launcher.exe");
  await fs.writeFile(executable, "old");
  let guarded = true,
    quit = false,
    helper;
  const raw = releaseRaw();
  raw.assets[0].digest = "sha512:not-supported";
  raw.assets.push({
    name: "SHA256SUMS-0.6.3.txt",
    browser_download_url:
      "https://github.com/KaMuMom/LDFCL/releases/download/v0.6.3/SHA256SUMS-0.6.3.txt",
    size: 200,
  });
  const updater = new LauncherUpdater({
    currentVersion: "0.6.2",
    executable,
    emit() {},
    canInstall: async () => {
      if (guarded) throw Error("game running");
    },
    quit() {
      quit = true;
    },
    fetchText: async (url) =>
      url.endsWith(".txt")
        ? `${hash(payload)}  ${raw.assets[0].name}`
        : JSON.stringify(raw),
    download: async (_release, file, expected) => {
      assert.equal(expected, hash(payload));
      await fs.writeFile(file, payload);
    },
    launchHelper: async (script, args) => {
      helper = { script, args };
    },
  });
  await updater.check();
  assert.equal((await updater.download()).status, "ready");
  await assert.rejects(updater.install(), /game running/);
  assert.equal(updater.state().status, "ready");
  assert.equal(quit, false);
  guarded = false;
  await updater.install();
  assert.equal(quit, true);
  assert.equal(updater.state().status, "installing");
  assert.equal(helper.args[0], "-Target");
  assert.equal(helper.args[1], executable);
  assert.equal(await fs.readFile(executable, "utf8"), "old");
});
test("non-portable update check allows release page without replacing any executable", async () => {
  const updater = new LauncherUpdater({
    currentVersion: "0.6.2",
    emit() {},
    canInstall: async () => {},
    quit() {},
    fetchText: async () => JSON.stringify(releaseRaw()),
  });
  assert.equal((await updater.check()).supported, false);
  assert.match((await updater.download()).message, /不支持应用内更新/);
});
test("installing update cannot be overwritten by duplicate install, check or download", async (t) => {
  const root = await temporary(t),
    executable = path.join(root, "launcher.exe");
  await fs.writeFile(executable, "old");
  let unlock,
    quit = 0;
  const updater = new LauncherUpdater({
    currentVersion: "0.6.2",
    executable,
    emit() {},
    canInstall: () =>
      new Promise((resolve) => {
        unlock = resolve;
      }),
    quit() {
      quit++;
    },
    fetchText: async () => JSON.stringify(releaseRaw()),
    download: async (_release, file) => fs.writeFile(file, payload),
    launchHelper: async () => {},
  });
  await updater.check();
  await updater.download();
  const installing = updater.install();
  assert.equal(updater.state().status, "installing");
  await assert.rejects(updater.install(), /完成更新下载/);
  assert.equal((await updater.download()).status, "installing");
  assert.equal((await updater.check()).status, "installing");
  unlock();
  await installing;
  assert.equal(quit, 1);
  assert.equal(updater.state().status, "installing");
});
test("same or older GitHub release never enables download even after a later check failure", async () => {
  let fail = false;
  const updater = new LauncherUpdater({
    currentVersion: "0.6.4",
    emit() {},
    canInstall: async () => {},
    quit() {},
    fetchText: async () => {
      if (fail) throw Error("network offline");
      return JSON.stringify(releaseRaw());
    },
  });
  const current = await updater.check();
  assert.equal(current.status, "current");
  assert.equal(current.hasUpdate, false);
  fail = true;
  const failed = await updater.check();
  assert.equal(failed.status, "error");
  assert.equal(failed.hasUpdate, false);
});

async function runHelper(script, arguments_) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        script,
        ...arguments_,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`PowerShell ${code}: ${output}`)),
    );
  });
}
test(
  "Windows PowerShell 5.1 helper replaces only EXE and retains backup with special-character paths",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await temporary(t);
    const folder = path.join(root, "中文 ' $ [update] & 空格");
    await fs.mkdir(folder);
    const target = path.join(folder, "LDFCL original.exe"),
      staged = path.join(folder, "new.exe"),
      backup = path.join(folder, "previous.exe"),
      script = path.join(folder, "update.ps1");
    await fs.writeFile(target, "original binary");
    await fs.copyFile(
      path.join(process.env.SystemRoot, "System32", "rundll32.exe"),
      staged,
    );
    const bytes = await fs.readFile(staged);
    await fs.writeFile(script, "\ufeff" + UPDATE_HELPER);
    for (const name of [".minecraft", "LDFCL-data"]) {
      await fs.mkdir(path.join(folder, name));
      await fs.writeFile(path.join(folder, name, "keep"), name);
    }
    await runHelper(script, [
      "-Target",
      target,
      "-Staged",
      staged,
      "-Backup",
      backup,
      "-Expected",
      hash(bytes),
      "-LauncherPid",
      "2147483647",
    ]);
    assert.equal(hash(await fs.readFile(target)), hash(bytes));
    assert.equal(await fs.readFile(backup, "utf8"), "original binary");
    for (const name of [".minecraft", "LDFCL-data"])
      assert.equal(
        await fs.readFile(path.join(folder, name, "keep"), "utf8"),
        name,
      );
    assert.match(
      await fs.readFile(path.join(folder, "update.log"), "utf8"),
      /Update installed/,
    );
  },
);
test(
  "Windows replacement helper preserves original on checksum failure and rolls back failed restart",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await temporary(t);
    for (const mismatch of [true, false]) {
      const folder = path.join(root, String(mismatch));
      await fs.mkdir(folder);
      const target = path.join(folder, "launcher.exe"),
        staged = path.join(folder, "new.exe"),
        backup = path.join(folder, "previous.exe"),
        script = path.join(folder, "update.ps1");
      await fs.writeFile(target, "original binary");
      await fs.writeFile(staged, payload);
      await fs.writeFile(script, "\ufeff" + UPDATE_HELPER);
      await runHelper(script, [
        "-Target",
        target,
        "-Staged",
        staged,
        "-Backup",
        backup,
        "-Expected",
        mismatch ? "0".repeat(64) : hash(payload),
        "-LauncherPid",
        "2147483647",
      ]);
      assert.equal(await fs.readFile(target, "utf8"), "original binary");
      const log = await fs.readFile(path.join(folder, "update.log"), "utf8");
      assert.ok(log.trim());
      assert.doesNotMatch(log, /Update installed/);
    }
  },
);
