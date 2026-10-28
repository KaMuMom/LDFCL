const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");

const project = path.resolve(__dirname, "..");

// The loader guard lives only in a disposable Node child. It cannot affect
// Electron fixtures or another test worker's module cache.
function inPlainNode(body) {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const originalLoad = Module._load;
const forbidden = [];
Module._load = function(request, ...args) {
  if (request === 'electron' || request.startsWith('electron/')) {
    forbidden.push(request);
    throw new Error('Core attempted to load Electron: ' + request);
  }
  return originalLoad.call(this, request, ...args);
};
global.fetch = async () => { throw new Error('Unexpected network request'); };
const { createLauncherCore } = require('@ldfcl/core/launcher');
const roots = [];
const cores = [];
const events = [];
const nativeCalls = [];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function host(overrides = {}) {
  return {
    chooseFiles: async (options) => {
      nativeCalls.push({ kind: 'open', options });
      return { canceled: true, filePaths: [] };
    },
    chooseSaveFile: async (options) => {
      nativeCalls.push({ kind: 'save', options });
      return { canceled: true };
    },
    openPath: async (target) => { nativeCalls.push({ kind: 'path', target }); return ''; },
    openExternal: async (url) => { nativeCalls.push({ kind: 'external', url }); },
    trashItem: async (target) => { nativeCalls.push({ kind: 'trash', target }); },
    imageDataUrl: () => { throw new Error('Unexpected native image decode'); },
    focusWindow: () => { nativeCalls.push({ kind: 'focus' }); },
    minimizeWindow: () => { nativeCalls.push({ kind: 'minimize' }); },
    ...overrides,
  };
}
async function profile(root, id = '1.21.1') {
  const directory = path.join(root, 'versions', id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, id + '.json'), JSON.stringify({
    id, mainClass: 'net.minecraft.client.main.Main', libraries: []
  }));
  return directory;
}
async function fixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'LDFCL-core-'));
  roots.push(root);
  const dataDir = path.join(root, 'LDFCL-data');
  const defaultGameRoot = path.join(root, '.minecraft');
  const instanceDirectory = await profile(defaultGameRoot);
  const options = { dataDir, defaultGameRoot, host: host(), emit: event => events.push(event), ...overrides };
  const core = await createLauncherCore(options);
  cores.push(core);
  return { root, dataDir, defaultGameRoot, instanceDirectory, options, core };
}
(async () => {
  try {
    ${body}
    assert.deepEqual(forbidden, [], 'Core tried to load an Electron dependency');
  } finally {
    for (const core of cores) core.dispose();
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
`,
    ],
    {
      cwd: project,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr || result.stdout,
  );
}

test("core and shared module references cannot import Electron or the desktop/renderer layers", async () => {
  const violations = [];
  let checked = 0;
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (/\.tsx?$/.test(entry.name)) {
        checked++;
        const source = ts.createSourceFile(
          file,
          await fs.readFile(file, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const check = (specifier) => {
          if (!specifier || !ts.isStringLiteralLike(specifier)) return;
          const name = specifier.text;
          const electron =
            name === "electron" ||
            name.startsWith("electron/") ||
            name.startsWith("@electron/");
          const resolved = name.startsWith(".")
            ? path.relative(project, path.resolve(path.dirname(file), name))
            : name;
          if (electron || /^(?:electron|src)(?:[\\/]|$)/.test(resolved))
            violations.push(`${path.relative(project, file)} -> ${name}`);
        };
        const visit = (node) => {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            check(node.moduleSpecifier);
          else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)
          )
            check(node.moduleReference.expression);
          else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) &&
                node.expression.text === "require"))
          )
            check(node.arguments[0]);
          else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument)
          )
            check(node.argument.literal);
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  }
  await inspect(path.join(project, "core"));
  await inspect(path.join(project, "shared"));
  assert(checked >= 25, "Architecture check did not cover the moved core");
  assert.deepEqual(violations, []);
});

test("plain Node loads the package, scans a real instance and preserves account/config schemas across restart", () => {
  inPlainNode(`
const f = await fixture();
let state = await f.core.state();
assert.equal(state.instances.length, 1);
assert.equal(state.instances[0].versionDirectory, '1.21.1');
assert.equal(state.system.gameRoot, f.defaultGameRoot);
assert.equal(state.system.dataDir, f.dataDir);
assert.deepEqual(state.accounts, []);
const account = await f.core.call('account:offline', { name: 'Core_QA' });
const duplicate = await f.core.call('account:offline', { name: 'Core_QA' });
assert.equal(account.id, duplicate.id);
assert.equal(account.uuid.length, 32);
for (const key of ['accessToken', 'refreshToken', 'clientToken']) assert.equal(key in account, false);
await f.core.call('settings', { downloadConcurrency: 3, closeOnLaunch: true });
const selected = (await f.core.state()).selectedInstanceId;
await f.core.call('select', { instanceId: selected, accountId: account.id });
const disk = JSON.parse(await fs.readFile(path.join(f.dataDir, 'launcher.json'), 'utf8'));
assert.deepEqual(Object.keys(disk).sort(), [
  'instances', 'gameDirectories', 'selectedGameDirectoryId',
  'selectedInstancesByDirectory', 'settings', 'selectedInstanceId', 'selectedAccountId'
].sort());
assert.equal(disk.selectedAccountId, account.id);
assert.equal(disk.settings.downloadConcurrency, 3);
assert.equal(disk.settings.gameRoot, f.defaultGameRoot);
const diskAccounts = JSON.parse(await fs.readFile(path.join(f.dataDir, 'accounts.json'), 'utf8'));
assert.equal(diskAccounts.length, 1);
assert.deepEqual(Object.keys(diskAccounts[0]).sort(), ['id', 'type', 'name', 'uuid'].sort());
assert(events.some(event => event.type === 'account' && event.account.id === account.id));
f.core.dispose();
const reloaded = await createLauncherCore(f.options);
cores.push(reloaded);
state = await reloaded.state();
assert.equal(state.selectedAccountId, account.id);
assert.equal(state.selectedInstanceId, selected);
assert.equal(state.accounts[0].uuid, account.uuid);
assert.equal(state.settings.closeOnLaunch, true);
assert.equal(state.instances.length, 1, 'Restart must not duplicate the discovered version');
assert.equal(nativeCalls.length, 0, 'Ordinary state/config operations must not call native UI');
`);
});

test("native directory and Mod pickers hold core gates until cancelled, and failed switching restores state", () => {
  inPlainNode(`
let activePicker;
const entered = () => {
  activePicker = { entered: deferred(), result: deferred() };
  return activePicker;
};
const f = await fixture({ host: host({
  chooseFiles: async options => {
    assert(activePicker, 'No picker was expected');
    activePicker.entered.resolve(options);
    return activePicker.result.promise;
  }
}) });
const initial = await f.core.state();
const id = initial.instances[0].id;
const otherRoot = path.join(f.root, 'second-game-root');
await profile(otherRoot, '1.20.1');
const otherState = await f.core.call('game-directory:add', { path: otherRoot });
const otherId = otherState.selectedGameDirectoryId;
await f.core.call('game-directory:select', { id: initial.selectedGameDirectoryId });
const before = await f.core.state();
const picker = entered();
const pendingDirectory = f.core.call('game-directory:add');
const directoryOptions = await picker.entered.promise;
assert(directoryOptions.properties.includes('openDirectory'));
assert(directoryOptions.properties.includes('createDirectory'));
await assert.rejects(f.core.call('versions'), /游戏目录正在切换/);
await assert.rejects(f.core.call('runtime'), /游戏目录正在切换/);
await assert.rejects(f.core.call('mods:list', { id }), /游戏目录正在切换/);
assert.equal((await f.core.state()).selectedGameDirectoryId, before.selectedGameDirectoryId);
picker.result.resolve({ canceled: true, filePaths: [] });
assert.equal(await pendingDirectory, null);
assert.equal((await f.core.state()).selectedInstanceId, before.selectedInstanceId);
const modPicker = entered();
const pendingMod = f.core.call('mods:import', { id });
const modOptions = await modPicker.entered.promise;
assert(modOptions.properties.includes('multiSelections'));
assert.deepEqual(modOptions.filters[0].extensions, ['jar']);
await assert.rejects(f.core.call('game-directory:select', { id: otherId }), /停止游戏.*等待/);
await assert.rejects(f.core.call('mods:list', { id }), /此实例正在运行或处理任务/);
modPicker.result.resolve({ canceled: true, filePaths: [] });
assert.equal(await pendingMod, null);
assert.deepEqual(await f.core.call('mods:list', { id }), []);
await assert.rejects(f.core.call('game-directory:add', { path: path.join(f.root, 'missing') }), /不存在/);
const restored = await f.core.state();
assert.equal(restored.selectedGameDirectoryId, before.selectedGameDirectoryId);
assert.equal(restored.selectedInstanceId, before.selectedInstanceId);
assert.deepEqual(restored.gameDirectories, before.gameDirectories);
assert(events.some(event => event.type === 'state'));
const afterSwitch = await f.core.call('game-directory:select', { id: otherId });
assert.equal(afterSwitch.selectedGameDirectoryId, otherId);
assert.equal(afterSwitch.instances[0].versionDirectory, '1.20.1');
`);
});

test("game task events retain the desktop progress/status contract and failed work releases its lock", () => {
  inPlainNode(`
// Only the game process/download boundary is controlled; dispatch, locks,
// event normalization and Store remain the actual core implementation.
const { GameService } = require(path.join(path.dirname(require.resolve('@ldfcl/core/launcher')), 'services', 'game.js'));
const original = GameService.prototype.install;
GameService.prototype.install = async function() {
  this.emit({ type: 'task', task: { id: 'controlled-game-task', title: 'fixture', progress: 0.375, status: 'failed', detail: 'preserved detail' } });
  throw new Error('controlled install failure');
};
try {
  const f = await fixture();
  await assert.rejects(f.core.call('install', { version: '1.21.1', loader: 'vanilla' }), /controlled install failure/);
  assert.deepEqual(events.find(event => event.type === 'task'), {
    type: 'task', task: { id: 'controlled-game-task', title: 'fixture', progress: 37.5, status: 'error', detail: 'preserved detail' }
  });
  const current = await f.core.state();
  // A leaked install lock would refuse the directory transaction.
  const rescanned = await f.core.call('game-directory:scan');
  assert.equal(rescanned.selectedGameDirectoryId, current.selectedGameDirectoryId);
  assert.equal(rescanned.instances.length, 1);
} finally {
  GameService.prototype.install = original;
}
`);
});
