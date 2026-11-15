const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  LauncherUpdater,
  UPDATE_HELPER,
  waitHelperReady,
} = require("@ldfcl/desktop/updater");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t, bytes, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-helper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "中文 ' $ [update] & 空格");
  const attempt = path.join(folder, ".ldfcl-update", "download", "attempt");
  await fs.mkdir(attempt, { recursive: true });
  const target = path.join(folder, "LDFCL original.exe");
  const staged = path.join(attempt, "new.exe");
  const backup = path.join(attempt, "previous.exe");
  const script = path.join(attempt, "update.ps1");
  const manifest = path.join(attempt, "transaction.json");
  await fs.writeFile(target, "original binary");
  await fs.writeFile(staged, bytes);
  await fs.writeFile(script, "\ufeff" + UPDATE_HELPER);
  const transaction = {
    schema: 1,
    id: "fixture-attempt",
    nonce: "a".repeat(64),
    target,
    staged,
    backup,
    expected: hash(bytes),
    version: "0.6.5",
    launcherPid: 2147483647,
    arguments: [],
    exitTimeoutMs: 1000,
    replaceTimeoutMs: 3000,
    healthTimeoutMs: 3000,
    healthGraceMs: 200,
    ...options,
  };
  await fs.writeFile(manifest, JSON.stringify(transaction));
  for (const name of [".minecraft", "LDFCL-data"]) {
    await fs.mkdir(path.join(folder, name));
    await fs.writeFile(path.join(folder, name, "keep"), name);
  }
  return {
    folder,
    attempt,
    target,
    staged,
    backup,
    script,
    manifest,
    transaction,
  };
}
async function runHelper(script, file) {
  return new Promise((resolve, reject) => {
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
        "-Transaction",
        file,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}
function updater(executable, currentVersion = "0.6.4") {
  return new LauncherUpdater({
    currentVersion,
    executable,
    emit() {},
    canInstall: async () => {},
    quit() {},
  });
}

test("helper readiness requires the exact attempt and nonce", async (t) => {
  const f = await fixture(t, Buffer.from("MZ fixture"));
  await fs.writeFile(
    path.join(f.attempt, "ready.json"),
    JSON.stringify({ id: f.transaction.id, nonce: "wrong" }),
  );
  await assert.rejects(waitHelperReady(f.manifest, f.transaction, 100), /握手/);
});

test(
  "PowerShell 5.1 refuses checksum mismatch and rolls back an executable which exits immediately",
  { skip: process.platform !== "win32" },
  async (t) => {
    const immediate = await fs.readFile(
      path.join(process.env.SystemRoot, "System32", "rundll32.exe"),
    );
    for (const mismatch of [true, false]) {
      const f = await fixture(
        t,
        immediate,
        mismatch ? { expected: "0".repeat(64) } : {},
      );
      const result = await runHelper(f.script, f.manifest);
      assert.equal(result.code, 1, result.output);
      const status = JSON.parse(
        await fs.readFile(path.join(f.attempt, "result.json"), "utf8"),
      );
      assert.equal(status.status, mismatch ? "failed" : "rolled-back");
      assert.match(
        status.message,
        mismatch ? /checksum mismatch/ : /exited before readiness/,
      );
      assert.equal(await fs.readFile(f.target, "utf8"), "original binary");
      for (const name of [".minecraft", "LDFCL-data"])
        assert.equal(
          await fs.readFile(path.join(f.folder, name, "keep"), "utf8"),
          name,
        );
      const restored = updater(f.target);
      assert.deepEqual(await restored.confirmStartup(), { autoCheck: false });
      assert.equal(restored.state().lastAttempt.status, status.status);
      assert.match(restored.state().message, /原版本|已保留/);
    }
  },
);

test("new pending attempt takes precedence over an older installed result", async (t) => {
  const f = await fixture(t, Buffer.from("MZ fixture"));
  const root = path.join(f.folder, ".ldfcl-update");
  await fs.writeFile(
    path.join(root, "last-result.json"),
    JSON.stringify({
      id: "old",
      status: "installed",
      version: "0.6.4",
      target: f.target,
      completedAt: new Date(Date.now() - 60000).toISOString(),
    }),
  );
  await fs.writeFile(
    path.join(root, "pending.json"),
    JSON.stringify({
      id: "new",
      version: "0.6.5",
      target: f.target,
      startedAt: new Date().toISOString(),
    }),
  );
  const candidate = updater(f.target);
  assert.deepEqual(await candidate.confirmStartup(), { autoCheck: false });
  assert.equal(candidate.state().lastAttempt.id, "new");
  assert.equal(candidate.state().lastAttempt.status, "failed");
});

test("healthy startup consumes its own result while the aggregate result still names an older attempt", async (t) => {
  const f = await fixture(t, Buffer.from("MZ fixture"));
  const root = path.join(f.folder, ".ldfcl-update");
  const oldEnvironment = [
    process.env.LDFCL_UPDATE_TRANSACTION,
    process.env.LDFCL_UPDATE_NONCE,
  ];
  t.after(() => {
    for (const [index, key] of [
      "LDFCL_UPDATE_TRANSACTION",
      "LDFCL_UPDATE_NONCE",
    ].entries())
      if (oldEnvironment[index] === undefined) delete process.env[key];
      else process.env[key] = oldEnvironment[index];
  });
  await fs.writeFile(
    path.join(root, "last-result.json"),
    JSON.stringify({
      id: "old",
      status: "installed",
      version: "0.6.4",
      target: f.target,
      completedAt: new Date(Date.now() - 60000).toISOString(),
    }),
  );
  process.env.LDFCL_UPDATE_TRANSACTION = f.manifest;
  process.env.LDFCL_UPDATE_NONCE = f.transaction.nonce;
  const candidate = updater(f.target, "0.6.5");
  const confirmation = candidate.confirmStartup();
  let healthy;
  for (let i = 0; i < 100; i++) {
    try {
      healthy = JSON.parse(
        await fs.readFile(path.join(f.attempt, "healthy.json"), "utf8"),
      );
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(healthy.nonce, f.transaction.nonce);
  await fs.writeFile(
    path.join(f.attempt, "result.json"),
    JSON.stringify({
      id: f.transaction.id,
      status: "installed",
      version: "0.6.5",
      target: f.target,
      completedAt: new Date().toISOString(),
    }),
  );
  assert.deepEqual(await confirmation, { autoCheck: true });
  assert.equal(candidate.state().lastAttempt.id, f.transaction.id);
  assert.equal(candidate.state().lastAttempt.version, "0.6.5");
});

test("startup receipts cannot write outside the update root or acknowledge another version", async (t) => {
  const f = await fixture(t, Buffer.from("MZ fixture"));
  const saved = {
    file: process.env.LDFCL_UPDATE_TRANSACTION,
    nonce: process.env.LDFCL_UPDATE_NONCE,
  };
  t.after(() => {
    for (const [key, value] of [
      ["LDFCL_UPDATE_TRANSACTION", saved.file],
      ["LDFCL_UPDATE_NONCE", saved.nonce],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  for (const file of [path.join(f.folder, "outside.json"), f.manifest]) {
    process.env.LDFCL_UPDATE_TRANSACTION = file;
    process.env.LDFCL_UPDATE_NONCE = f.transaction.nonce;
    const candidate = updater(f.target);
    assert.deepEqual(await candidate.confirmStartup(), { autoCheck: false });
    assert.equal(candidate.state().status, "error");
    await assert.rejects(
      fs.access(path.join(f.attempt, "healthy.json")),
      /ENOENT/,
    );
  }
});
