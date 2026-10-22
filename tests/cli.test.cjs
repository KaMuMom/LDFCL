const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const bin = path.join(root, "bin", "ldfcl-cli.cjs");
const compiled = path.join(root, "dist-electron", "cli", "main.js");

async function put(filename, contents) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL CLI 中文 "));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const guard = path.join(directory, "read-only-guard.cjs");
  await put(
    guard,
    `
const Module = require('node:module');
const fs = require('node:fs');
const promises = require('node:fs/promises');
const path = require('node:path');
let violated = false;
function forbidden(message) {
  violated = true;
  process.stderr.write('FORBIDDEN: ' + message + '\\n');
  throw Error(message);
}
process.on('beforeExit', () => { if (violated) process.exitCode = 93; });
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'electron' || /(?:^|[\\\\/])accounts(?:\\.js)?$/.test(request))
    forbidden('CLI loaded Electron or account service');
  return originalLoad.call(this, request, ...args);
};
function protectedAccount(value) {
  return typeof value === 'string' && path.basename(value).toLowerCase() === 'accounts.json';
}
for (const [target, name] of [[fs,'readFileSync'], [fs,'readFile'], [fs,'openSync'], [fs,'open'], [promises,'readFile'], [promises,'open']]) {
  const original = target[name];
  target[name] = function(file, ...args) {
    if (protectedAccount(file)) forbidden('CLI read account tokens');
    return original.call(this, file, ...args);
  };
}
const fixtureRoot = path.resolve(process.env.LDFCL_CLI_TEST_ROOT).toLowerCase();
function inFixture(value) {
  if (typeof value !== 'string') return false;
  const selected = path.resolve(value).toLowerCase();
  return selected === fixtureRoot || selected.startsWith(fixtureRoot + path.sep);
}
for (const [target, names] of [[promises,['mkdir','writeFile','appendFile','rename','copyFile','cp','rm','unlink','rmdir']], [fs,['mkdirSync','writeFileSync','appendFileSync','renameSync','copyFileSync','cpSync','rmSync','unlinkSync','rmdirSync']]]) {
  for (const name of names) {
    const original = target[name];
    target[name] = function(...args) {
      if (args.some(inFixture)) forbidden('CLI wrote fixture via ' + name);
      return original.apply(this, args);
    };
  }
}
global.fetch = () => forbidden('CLI made a network request');
if (process.env.LDFCL_CLI_TEST_JAVA) {
  const cp = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  // The host can restore system environment variables for child processes.
  // Bound discovery's filesystem view as well, so this fixture never probes
  // installed system JVMs while still using the production discovery logic.
  const originalStat = promises.stat;
  const originalReaddir = promises.readdir;
  promises.stat = function(file, ...args) {
    if (typeof file === 'string' && path.isAbsolute(file) && !inFixture(file)) {
      const error = Object.assign(Error('Outside controlled Java fixture'), {code:'ENOENT'});
      return Promise.reject(error);
    }
    return originalStat.call(this, file, ...args);
  };
  promises.readdir = function(directory, ...args) {
    if (!inFixture(directory)) return Promise.resolve([]);
    return originalReaddir.call(this, directory, ...args);
  };
  require('node:os').homedir = () => process.env.LDFCL_CLI_TEST_ROOT;
  cp.spawn = function(executable, args) {
    const expected = process.env.LDFCL_CLI_TEST_JAVA;
    if (executable !== 'java' && path.resolve(executable).toLowerCase() !== path.resolve(expected).toLowerCase())
      forbidden('Unexpected Java executable: ' + executable);
    if (JSON.stringify(args) !== JSON.stringify(['-XshowSettings:properties','-version']))
      forbidden('CLI attempted to install or run a game');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stderr.end('Property settings:\\n    java.version = 21.0.8\\n    java.home = ' + path.dirname(path.dirname(expected)) + '\\n    os.arch = amd64\\n');
      child.stdout.end();
      child.emit('close',0);
    });
    return child;
  };
}
`,
  );
  return {
    directory,
    guard,
    dataDir: path.join(directory, "启动器 配置"),
    gameRoot: path.join(directory, "游戏 根", ".minecraft"),
  };
}

function run(f, args, extras = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, LDFCL_CLI_TEST_ROOT: f.directory };
    delete env.LDFCL_DATA_DIR;
    delete env.LDFCL_GAME_ROOT;
    delete env.NODE_OPTIONS;
    // Windows child-process environment keys are case-insensitive. Remove old
    // spellings before overriding, otherwise PROGRAMFILES can beat ProgramFiles.
    if (process.platform === "win32") {
      const overrides = new Set(
        Object.keys(extras.env || {}).map((key) => key.toLowerCase()),
      );
      for (const key of Object.keys(env))
        if (overrides.has(key.toLowerCase())) delete env[key];
    }
    Object.assign(env, extras.env || {});
    const child = spawn(
      process.execPath,
      ["--require", f.guard, extras.entry || bin, ...args],
      {
        cwd: extras.cwd || root,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("CLI subprocess timed out"));
    }, 30000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function snapshot(directory) {
  const result = [];
  async function walk(current) {
    const stat = await fs.stat(current);
    const relative = path.relative(directory, current);
    if (stat.isDirectory()) {
      result.push([relative, "directory", stat.mtimeMs]);
      for (const name of (await fs.readdir(current)).sort())
        await walk(path.join(current, name));
    } else {
      result.push([
        relative,
        "file",
        stat.mtimeMs,
        createHash("sha256")
          .update(await fs.readFile(current))
          .digest("hex"),
      ]);
    }
  }
  await walk(directory);
  return result;
}

function instance(id, directoryId, extras = {}) {
  return {
    id,
    name: `实例 ${id}`,
    version: "1.21.1",
    loader: "fabric",
    createdAt: "2026-10-22T00:00:00.000Z",
    gameSettings: {},
    ...(directoryId ? { gameDirectoryId: directoryId } : {}),
    ...extras,
  };
}

test("CLI instance list reads registered roots and filters Chinese spaced paths without Electron, accounts, network or writes", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.directory, "另一个游戏根");
  const secret = randomUUID();
  await put(
    path.join(f.dataDir, "launcher.json"),
    JSON.stringify({
      instances: [
        instance("one", "game-a", { versionDirectory: "中文 版本 Fabric" }),
        instance("two", "game-b", { versionDirectory: "1.20.1" }),
      ],
      gameDirectories: [
        {
          id: "game-a",
          name: "中文游戏目录",
          path: f.gameRoot,
          layout: "standard",
        },
        { id: "game-b", name: "第二目录", path: other, layout: "standard" },
      ],
      selectedGameDirectoryId: "game-a",
      selectedInstanceId: "one",
      selectedAccountId: secret,
      settings: { microsoftClientId: secret },
    }),
  );
  await put(
    path.join(f.dataDir, "accounts.json"),
    JSON.stringify({ accessToken: secret }),
  );
  const before = await snapshot(f.directory);
  const all = await run(f, [
    "instance",
    "list",
    "--json",
    "--data-dir",
    f.dataDir,
  ]);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.stderr, "");
  const value = JSON.parse(all.stdout);
  assert.equal(value.instances.length, 2);
  assert.equal(
    value.instances[0].directory,
    path.join(f.gameRoot, "versions", "中文 版本 Fabric"),
  );
  assert.equal(value.instances[0].selected, true);
  assert.equal(value.instances[1].selected, false);
  assert.equal(all.stdout.includes(secret), false);
  const filtered = await run(f, [
    "--json",
    "instance",
    "list",
    `--data-dir=${f.dataDir}`,
    "--game-root",
    f.gameRoot,
  ]);
  assert.equal(filtered.code, 0, filtered.stderr);
  assert.deepEqual(
    JSON.parse(filtered.stdout).instances.map((item) => item.id),
    ["one"],
  );
  const human = await run(f, ["instance", "list", "--data-dir", f.dataDir]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /MINECRAFT/);
  assert.match(human.stdout, /中文 版本 Fabric/);
  assert.deepEqual(await snapshot(f.directory), before);
});

test("CLI legacy fixtures report old instances where they live without config or filesystem migration", async (t) => {
  const f = await fixture(t);
  const oldDirectory = path.join(f.dataDir, "instances", "old-one");
  await put(
    path.join(f.dataDir, "launcher.json"),
    JSON.stringify({
      instances: [instance("old-one", undefined, { loader: "vanilla" })],
      selectedInstanceId: "old-one",
      settings: {},
    }),
  );
  await put(path.join(oldDirectory, "saves", "保留存档.dat"), "original world");
  const before = await snapshot(f.directory);
  const result = await run(f, [
    "instance",
    "list",
    "--json",
    "--data-dir",
    f.dataDir,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.instances.length, 1);
  assert.equal(value.instances[0].directory, oldDirectory);
  assert.equal(value.instances[0].pendingMigration, true);
  assert.equal(value.instances[0].gameRoot, path.join(f.dataDir, "minecraft"));
  assert.deepEqual(await snapshot(f.directory), before);
});

test("CLI java list discovers controlled local Java through the real manager without ensure/download or writes", async (t) => {
  const f = await fixture(t);
  const executable = path.join(
    f.gameRoot,
    "runtime",
    "测试 Java 21",
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  await put(executable, "controlled Java executable placeholder");
  const before = await snapshot(f.directory);
  const result = await run(
    f,
    [
      "java",
      "list",
      "--json",
      "--data-dir",
      f.dataDir,
      "--game-root",
      f.gameRoot,
    ],
    {
      env: {
        LDFCL_CLI_TEST_JAVA: executable,
        JAVA_HOME: path.dirname(path.dirname(executable)),
        JDK_HOME: "",
        PATH: path.dirname(executable),
        Path: path.dirname(executable),
        ProgramFiles: path.join(f.directory, "No installed programs"),
        APPDATA: path.join(f.directory, "No app data"),
      },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.gameRoot, f.gameRoot);
  assert.equal(value.runtimeDataDir, f.gameRoot);
  assert.equal(value.java.length, 1);
  assert.equal(value.java[0].path, await fs.realpath(executable));
  assert.equal(value.java[0].major, 21);
  assert.equal(value.java[0].version, "21.0.8");
  assert.equal(value.java[0].architecture, "x64");
  assert.deepEqual(await snapshot(f.directory), before);
});

test("CLI default program and environment paths are read-only even when configuration does not exist", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.directory);
  const result = await run(f, [
    "instance",
    "list",
    "--json",
    "--program-dir",
    f.directory,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.dataDir, path.join(f.directory, "LDFCL-data"));
  assert.equal(
    value.gameDirectories[0].path,
    path.join(f.directory, ".minecraft"),
  );
  assert.deepEqual(value.instances, []);
  const environment = await run(f, ["instance", "list", "--json"], {
    env: { LDFCL_DATA_DIR: f.dataDir, LDFCL_GAME_ROOT: f.gameRoot },
  });
  assert.equal(environment.code, 0, environment.stderr);
  assert.equal(JSON.parse(environment.stdout).dataDir, f.dataDir);
  assert.equal(
    JSON.parse(environment.stdout).gameDirectories[0].path,
    f.gameRoot,
  );
  assert.deepEqual(await snapshot(f.directory), before);
});

test("CLI reports corrupted launcher config without backups, overwriting or reading accounts", async (t) => {
  const f = await fixture(t);
  const marker = `CLI_PRIVATE_${randomUUID().slice(0, 8)}`;
  const corrupted = `{"privateMarker":"${marker}", INVALID_JSON_MARKER}`;
  const config = path.join(f.dataDir, "launcher.json");
  await put(config, corrupted);
  const before = await snapshot(f.directory);
  const result = await run(f, [
    "instance",
    "list",
    "--json",
    "--data-dir",
    f.dataDir,
  ]);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error.code, "LIST_FAILED");
  for (const fragment of [marker, "privateMarker", "INVALID_JSON_MARKER"])
    assert.equal((result.stdout + result.stderr).includes(fragment), false);
  assert.equal(await fs.readFile(config, "utf8"), corrupted);
  assert.deepEqual(await snapshot(f.directory), before);
});

test("CLI rejects unknown commands/options, duplicate path flags and missing values with nonzero structured errors", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["instance", "remove", "--json"],
    ["no-such-command", "--json"],
    ["instance", "list", "--unknown", "--json"],
    ["instance", "list", "--data-dir", "--json"],
    [
      "instance",
      "list",
      "--data-dir",
      f.dataDir,
      "--data-dir",
      f.dataDir,
      "--json",
    ],
  ]) {
    const result = await run(f, args);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_ARGUMENTS");
  }
});

test("CLI bin and compiled entry expose help/version without loading Electron or opening data", async (t) => {
  const f = await fixture(t);
  const help = await run(f, ["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /ldfcl-cli instance list/);
  assert.match(help.stdout, /ldfcl-cli java list/);
  const version = await run(f, ["--version", "--json"], { entry: compiled });
  assert.equal(version.code, 0, version.stderr);
  assert.equal(
    JSON.parse(version.stdout).version,
    require("../package.json").version,
  );
});
