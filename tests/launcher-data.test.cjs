const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "dist-electron");
const { prepareLauncherDataDirectory } = require(
  path.join(compiledRoot, "electron", "launcher-data.js"),
);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-data-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    destination: path.join(root, "便携启动器", ".ldfcl"),
    legacy: path.join(root, "旧 AppData"),
  };
}
async function put(root, filename, bytes) {
  const target = path.join(root, filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return target;
}
async function noStages(destination) {
  assert.deepEqual(
    (await fs.readdir(path.dirname(destination))).filter((name) =>
      name.startsWith(".ldfcl-migration-"),
    ),
    [],
  );
}

test("first preparation copies only bounded configuration and translations, preserving source bytes and game data", async (t) => {
  const { destination, legacy } = await fixture(t);
  const files = {
    "launcher.json": Buffer.from('\ufeff{ "instances": [] }\r\n'),
    "accounts.json": Buffer.from('{"encrypted":"synthetic-fixture-only"}\r\n'),
    "translations/mods/自定义.json": Buffer.from('{"name":"自定义翻译"}\n'),
  };
  for (const [name, bytes] of Object.entries(files))
    await put(legacy, name, bytes);
  await put(legacy, "translations/mods/notes.txt", "not a catalogue");
  await put(
    legacy,
    "translations/mods/nested/hidden.json",
    "not an immediate catalogue",
  );
  const game = await put(
    legacy,
    "minecraft/instances/world/saves/level.dat",
    "untouched-world",
  );
  assert.deepEqual(await prepareLauncherDataDirectory(destination, legacy), {
    legacyDataDir: legacy,
  });
  for (const [name, bytes] of Object.entries(files)) {
    assert.deepEqual(await fs.readFile(path.join(destination, name)), bytes);
    assert.deepEqual(await fs.readFile(path.join(legacy, name)), bytes);
  }
  assert.equal(await fs.readFile(game, "utf8"), "untouched-world");
  await assert.rejects(
    fs.access(path.join(destination, "minecraft")),
    /ENOENT/,
  );
  await assert.rejects(
    fs.access(path.join(destination, "translations/mods/notes.txt")),
    /ENOENT/,
  );
  await assert.rejects(
    fs.access(path.join(destination, "translations/mods/nested")),
    /ENOENT/,
  );
  const marker = JSON.parse(
    await fs.readFile(path.join(destination, "storage-migration.json"), "utf8"),
  );
  assert.equal(marker.sourceDataDir, legacy);
  assert.equal(marker.formatVersion, 1);
  assert.deepEqual(marker.files.sort(), Object.keys(files).sort());
  await noStages(destination);
});

test("an existing target never merges old settings or resurrects a deleted account", async (t) => {
  const { destination, legacy } = await fixture(t);
  await put(legacy, "accounts.json", "old account bytes");
  await put(legacy, "launcher.json", "old settings");
  await prepareLauncherDataDirectory(destination, legacy);
  await fs.rm(path.join(destination, "accounts.json"));
  await fs.writeFile(path.join(destination, "launcher.json"), "new settings");
  await fs.rm(legacy, { recursive: true });
  // A legacy source that is now a file would be rejected if it were inspected.
  await fs.writeFile(legacy, "do not read this obsolete source");
  assert.deepEqual(await prepareLauncherDataDirectory(destination, legacy), {
    legacyDataDir: legacy,
  });
  assert.equal(
    await fs.readFile(path.join(destination, "launcher.json"), "utf8"),
    "new settings",
  );
  await assert.rejects(
    fs.access(path.join(destination, "accounts.json")),
    /ENOENT/,
  );
  await noStages(destination);
});

test("a pre-existing unmarked target is used directly and does not inspect or import the legacy source", async (t) => {
  const { destination, legacy } = await fixture(t);
  await put(destination, "launcher.json", "existing settings");
  await fs.writeFile(legacy, "not a directory");
  assert.deepEqual(await prepareLauncherDataDirectory(destination, legacy), {});
  assert.equal(
    await fs.readFile(path.join(destination, "launcher.json"), "utf8"),
    "existing settings",
  );
  await assert.rejects(
    fs.access(path.join(destination, "storage-migration.json")),
    /ENOENT/,
  );
});

test("the migration marker restores the original legacy path without requiring the old directory to exist", async (t) => {
  const { destination, legacy } = await fixture(t);
  await put(
    destination,
    "storage-migration.json",
    JSON.stringify({ sourceDataDir: legacy }),
  );
  assert.deepEqual(await prepareLauncherDataDirectory(destination), {
    legacyDataDir: legacy,
  });
  for (const marker of [
    "broken JSON",
    "null",
    JSON.stringify({ sourceDataDir: "relative/path" }),
    JSON.stringify({ sourceDataDir: destination }),
  ]) {
    await fs.writeFile(
      path.join(destination, "storage-migration.json"),
      marker,
    );
    assert.deepEqual(await prepareLauncherDataDirectory(destination), {});
  }
});

test("missing and irrelevant legacy directories still produce a usable empty target", async (t) => {
  const { root, destination, legacy } = await fixture(t);
  assert.deepEqual(await prepareLauncherDataDirectory(destination, legacy), {});
  await put(legacy, "minecraft/assets/asset", "game bytes");
  const other = path.join(root, "other", ".ldfcl");
  assert.deepEqual(await prepareLauncherDataDirectory(other, legacy), {});
  assert.deepEqual(
    (await fs.readdir(other)).filter(
      (name) => name !== "storage-migration.json",
    ),
    [],
  );
  assert.deepEqual(
    await prepareLauncherDataDirectory(path.join(root, "explicit")),
    {},
  );
});

test("a failed atomic publication leaves no partial target and a later attempt can migrate normally", async (t) => {
  const { destination, legacy } = await fixture(t);
  await put(legacy, "launcher.json", "settings");
  await put(legacy, "accounts.json", "account bytes");
  const originalRename = fs.rename;
  let fail = true;
  fs.rename = async (from, to) => {
    if (fail && String(to) === destination) {
      fail = false;
      const error = new Error("simulated publication failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRename(from, to);
  };
  t.after(() => {
    fs.rename = originalRename;
  });
  await assert.rejects(
    prepareLauncherDataDirectory(destination, legacy),
    /simulated publication failure/,
  );
  await assert.rejects(fs.access(destination), /ENOENT/);
  await noStages(destination);
  assert.equal(
    await fs.readFile(path.join(legacy, "accounts.json"), "utf8"),
    "account bytes",
  );
  assert.deepEqual(await prepareLauncherDataDirectory(destination, legacy), {
    legacyDataDir: legacy,
  });
  assert.equal(
    await fs.readFile(path.join(destination, "launcher.json"), "utf8"),
    "settings",
  );
  await noStages(destination);
});

test("a concurrent publisher wins without being overwritten and its marker controls the returned legacy path", async (t) => {
  const { root, destination, legacy } = await fixture(t);
  await put(legacy, "launcher.json", "losing settings");
  const winnerSource = path.join(root, "winning-old-source");
  const originalRename = fs.rename;
  let injected = false;
  fs.rename = async (from, to) => {
    if (!injected && String(to) === destination) {
      injected = true;
      await put(destination, "launcher.json", "winning settings");
      await put(
        destination,
        "storage-migration.json",
        JSON.stringify({ sourceDataDir: winnerSource }),
      );
      const error = new Error("destination created concurrently");
      error.code = "ENOTEMPTY";
      throw error;
    }
    return originalRename(from, to);
  };
  t.after(() => {
    fs.rename = originalRename;
  });
  assert.deepEqual(await prepareLauncherDataDirectory(destination, legacy), {
    legacyDataDir: winnerSource,
  });
  assert.equal(
    await fs.readFile(path.join(destination, "launcher.json"), "utf8"),
    "winning settings",
  );
  await noStages(destination);
});

test("simultaneous callers initialize the destination once", async (t) => {
  const { destination, legacy } = await fixture(t);
  await put(legacy, "accounts.json", "one original");
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      prepareLauncherDataDirectory(destination, legacy),
    ),
  );
  assert(results.every((result) => result.legacyDataDir === legacy));
  assert.equal(
    await fs.readFile(path.join(destination, "accounts.json"), "utf8"),
    "one original",
  );
  await noStages(destination);
});

test("configuration exceeding 16 MiB aborts the whole stage, preserving the source", async (t) => {
  const { destination, legacy } = await fixture(t);
  await put(
    legacy,
    "launcher.json",
    "settings would otherwise be copied first",
  );
  const file = await put(legacy, "accounts.json", "");
  await fs.truncate(file, 16 * 1024 * 1024 + 1);
  await assert.rejects(
    prepareLauncherDataDirectory(destination, legacy),
    /大小/,
  );
  await assert.rejects(fs.access(destination), /ENOENT/);
  assert.equal((await fs.stat(file)).size, 16 * 1024 * 1024 + 1);
  await noStages(destination);
});

test("translation count and individual file size are bounded before publication", async (t) => {
  const { root, destination, legacy } = await fixture(t);
  for (let index = 0; index < 257; index++)
    await put(legacy, `translations/mods/${index}.json`, "{}");
  await assert.rejects(
    prepareLauncherDataDirectory(destination, legacy),
    /数量/,
  );
  await assert.rejects(fs.access(destination), /ENOENT/);
  await noStages(destination);
  const oversizedSource = path.join(root, "large-translations");
  const file = await put(oversizedSource, "translations/mods/large.json", "");
  await fs.truncate(file, 4 * 1024 * 1024 + 1);
  await assert.rejects(
    prepareLauncherDataDirectory(destination, oversizedSource),
    /大小/,
  );
  await noStages(destination);
});

test("invalid destinations, file destinations and junction destinations are rejected", async (t) => {
  const { root, destination, legacy } = await fixture(t);
  for (const invalid of [
    "relative",
    "",
    `${root}\0bad`,
    path.join(root, "bad:stream"),
    path.join(root, "NUL"),
  ])
    await assert.rejects(prepareLauncherDataDirectory(invalid), /路径|目录/);
  await put(root, "file-target", "file");
  await assert.rejects(
    prepareLauncherDataDirectory(path.join(root, "file-target")),
    /普通目录/,
  );
  await fs.mkdir(legacy);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.symlink(
    legacy,
    destination,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(prepareLauncherDataDirectory(destination), /联接|链接/);
  const nested = path.join(root, "linked-parent", ".ldfcl");
  await fs.symlink(
    legacy,
    path.dirname(nested),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(prepareLauncherDataDirectory(nested), /联接|链接/);
  assert.deepEqual(await fs.readdir(legacy), []);
});

test("linked or non-file source configuration is rejected instead of being followed", async (t) => {
  const { root, destination, legacy } = await fixture(t);
  const outside = await put(root, "outside.json", "external original");
  await fs.mkdir(legacy);
  if (process.platform === "win32") {
    await fs.mkdir(path.join(legacy, "accounts.json"));
  } else {
    await fs.symlink(outside, path.join(legacy, "accounts.json"));
  }
  await assert.rejects(
    prepareLauncherDataDirectory(destination, legacy),
    /普通文件/,
  );
  await assert.rejects(fs.access(destination), /ENOENT/);
  assert.equal(await fs.readFile(outside, "utf8"), "external original");
  await noStages(destination);
});

test("writability and existing-marker read errors are surfaced without falling back to another location", async (t) => {
  const { destination } = await fixture(t);
  await fs.mkdir(destination, { recursive: true });
  const originalOpen = fs.open;
  fs.open = async (file, ...args) => {
    if (path.basename(String(file)).startsWith(".ldfcl-write-")) {
      const error = new Error("simulated read-only destination");
      error.code = "EACCES";
      throw error;
    }
    return originalOpen(file, ...args);
  };
  t.after(() => {
    fs.open = originalOpen;
  });
  await assert.rejects(
    prepareLauncherDataDirectory(destination),
    /simulated read-only destination/,
  );
  fs.open = originalOpen;
  await put(destination, "storage-migration.json", "{}");
  fs.open = async (file, ...args) => {
    if (path.basename(String(file)) === "storage-migration.json") {
      const error = new Error("simulated unreadable migration record");
      error.code = "EACCES";
      throw error;
    }
    return originalOpen(file, ...args);
  };
  await assert.rejects(
    prepareLauncherDataDirectory(destination),
    /simulated unreadable migration record/,
  );
});
