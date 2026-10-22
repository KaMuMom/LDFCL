const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Store } = process.env.LDFCL_TEST_CLIENT_CONFIG_ROOT
  ? require(
      path.join(process.env.LDFCL_TEST_CLIENT_CONFIG_ROOT, "core/store.js"),
    )
  : require("@ldfcl/core/store");

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";

function encryptedStorage() {
  const key = crypto.randomBytes(32);
  const control = { available: true, failEncrypt: false, encryptions: 0 };
  const storage = {
    isEncryptionAvailable: () => control.available,
    encryptString(value) {
      control.encryptions++;
      if (control.failEncrypt)
        throw Error(`Synthetic encryption failure: ${value}`);
      const iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const content = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, content, cipher.getAuthTag()]);
    },
    decryptString(buffer) {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        buffer.subarray(0, 12),
      );
      decipher.setAuthTag(buffer.subarray(-16));
      return Buffer.concat([
        decipher.update(buffer.subarray(12, -16)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
  return { control, storage };
}

async function fixture(t, settings) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-client-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "launcher.json"),
    secure = encryptedStorage();
  if (settings)
    await fs.writeFile(
      file,
      JSON.stringify(
        { settings, selectedAccountId: "synthetic-account" },
        null,
        2,
      ),
    );
  return {
    root,
    file,
    ...secure,
    create: (secretStorage = secure.storage) =>
      new Store(root, { secretStorage }),
  };
}

function assertPublic(store, status, configured) {
  assert.equal(store.settings.microsoftClientId, "");
  assert.equal(store.settings.microsoftClientIdConfigured, configured);
  assert.equal(store.settings.microsoftClientIdStorageStatus, status);
  for (const value of [firstId, secondId]) {
    assert.equal(JSON.stringify(store.settings).includes(value), false);
    assert.equal(JSON.stringify(store).includes(value), false);
  }
}

test("legacy client ID migrates to ciphertext and survives restart without entering public state", async (t) => {
  const f = await fixture(t, {
    microsoftClientId: firstId,
    downloadConcurrency: 13,
  });
  const store = f.create();
  await store.load();
  assert.equal(store.getMicrosoftClientId(), firstId);
  assertPublic(store, "ready", true);
  const persisted = await fs.readFile(f.file, "utf8"),
    disk = JSON.parse(persisted);
  assert.equal(persisted.includes(firstId), false);
  assert.equal(disk.settings.microsoftClientId, "");
  assert.equal(disk.settings.downloadConcurrency, 13);
  assert.equal(disk.selectedAccountId, "synthetic-account");
  assert(disk.microsoftClientConfiguration.encryptedClientId);
  const restarted = f.create();
  await restarted.load();
  assert.equal(restarted.getMicrosoftClientId(), firstId);
  assertPublic(restarted, "ready", true);
  assert.equal(
    f.control.encryptions,
    1,
    "reopening must retain existing ciphertext",
  );
});

test("read-only loading never migrates or rewrites a legacy client ID", async (t) => {
  const f = await fixture(t, { microsoftClientId: firstId });
  const before = await fs.readFile(f.file),
    files = await fs.readdir(f.root);
  const store = f.create();
  await store.load({ readOnly: true });
  assertPublic(store, "migration-pending", false);
  assert.throws(
    () => store.getMicrosoftClientId(),
    (error) => !error.message.includes(firstId),
  );
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.deepEqual(await fs.readdir(f.root), files);
  assert.equal(f.control.encryptions, 0);
});

test("unavailable encryption preserves legacy bytes and startup, rejecting mutations until safe migration succeeds", async (t) => {
  const f = await fixture(t, {
    microsoftClientId: firstId,
    downloadConcurrency: 13,
  });
  f.control.available = false;
  const before = await fs.readFile(f.file),
    store = f.create();
  await store.load();
  await store.save({ initialization: true });
  assertPublic(store, "migration-pending", false);
  assert.throws(() => store.getMicrosoftClientId(), /安全迁移/);
  await assert.rejects(
    store.updateSettings({ downloadConcurrency: 7 }),
    /安全存储/,
  );
  await assert.rejects(store.save(), /安全存储/);
  assert.equal(store.settings.downloadConcurrency, 13);
  assert.deepEqual(await fs.readFile(f.file), before);
  f.control.available = true;
  await store.updateSettings({ downloadConcurrency: 7 });
  assert.equal(store.getMicrosoftClientId(), firstId);
  assert.equal(store.settings.downloadConcurrency, 7);
  assertPublic(store, "ready", true);
  assert.equal((await fs.readFile(f.file, "utf8")).includes(firstId), false);
});

test("new ID has no plaintext fallback and encryption errors never echo submitted values", async (t) => {
  const f = await fixture(t),
    store = f.create();
  await store.load();
  const before = await fs.readFile(f.file);
  f.control.available = false;
  await assert.rejects(
    store.updateSettings({ microsoftClientId: firstId, memoryMb: 6144 }),
    (error) => !error.message.includes(firstId),
  );
  assert.equal(store.getMicrosoftClientId(), "");
  assert.equal(store.settings.memoryMb, 4096);
  assert.deepEqual(await fs.readFile(f.file), before);
  f.control.available = true;
  f.control.failEncrypt = true;
  await assert.rejects(
    store.updateSettings({ microsoftClientId: firstId }),
    (error) => !error.message.includes(firstId),
  );
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal(
    (await fs.readdir(f.root)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("unreadable or different-user ciphertext stays recoverable and can be replaced", async (t) => {
  const f = await fixture(t),
    store = f.create();
  await store.load();
  await store.updateSettings({ microsoftClientId: firstId });
  const original = JSON.parse(
    await fs.readFile(f.file, "utf8"),
  ).microsoftClientConfiguration;
  const otherUser = encryptedStorage(),
    locked = f.create(otherUser.storage);
  await locked.load();
  assertPublic(locked, "unreadable", false);
  assert.throws(() => locked.getMicrosoftClientId(), /重新配置/);
  await locked.updateSettings({ downloadConcurrency: 7 });
  assert.deepEqual(
    JSON.parse(await fs.readFile(f.file, "utf8")).microsoftClientConfiguration,
    original,
  );
  await locked.updateSettings({ microsoftClientId: secondId });
  assert.equal(locked.getMicrosoftClientId(), secondId);
  assertPublic(locked, "ready", true);
  const disk = JSON.parse(await fs.readFile(f.file, "utf8"));
  disk.microsoftClientConfiguration.encryptedClientId = "invalid-encoding";
  await fs.writeFile(f.file, JSON.stringify(disk));
  const corrupt = f.create();
  await corrupt.load();
  assertPublic(corrupt, "unreadable", false);
  assert.throws(() => corrupt.getMicrosoftClientId(), /重新配置/);
  assert.equal(
    JSON.parse(await fs.readFile(f.file, "utf8")).microsoftClientConfiguration
      .encryptedClientId,
    "invalid-encoding",
  );
});

test("atomic publication failure leaves effective client ID and all submitted settings unchanged", async (t) => {
  const f = await fixture(t),
    store = f.create();
  await store.load();
  await store.updateSettings({ microsoftClientId: firstId });
  const before = await fs.readFile(f.file),
    memoryBefore = store.settings.memoryMb;
  const rename = fs.rename;
  fs.rename = async (source, target) => {
    if (target === f.file)
      throw Object.assign(Error("Synthetic publish failure"), {
        code: "EACCES",
      });
    return rename(source, target);
  };
  try {
    await assert.rejects(
      store.updateSettings({ microsoftClientId: secondId, memoryMb: 6144 }),
      /Synthetic publish failure/,
    );
    assert.equal(store.getMicrosoftClientId(), firstId);
    assert.equal(store.settings.memoryMb, memoryBefore);
    assertPublic(store, "ready", true);
    assert.deepEqual(await fs.readFile(f.file), before);
    await assert.rejects(fs.access(f.file + ".tmp"), { code: "ENOENT" });
  } finally {
    fs.rename = rename;
  }
  await store.updateSettings({ microsoftClientId: secondId });
  assert.equal(store.getMicrosoftClientId(), secondId);
});

test("failed automatic migration preserves the original and does not enable an uncommitted ID", async (t) => {
  const f = await fixture(t, { microsoftClientId: firstId }),
    before = await fs.readFile(f.file);
  const rename = fs.rename;
  fs.rename = async (source, target) => {
    if (target === f.file)
      throw Object.assign(Error("Synthetic migration failure"), {
        code: "EACCES",
      });
    return rename(source, target);
  };
  const store = f.create();
  try {
    await store.load();
    assertPublic(store, "migration-pending", false);
    assert.throws(() => store.getMicrosoftClientId(), /安全迁移/);
    assert.deepEqual(await fs.readFile(f.file), before);
  } finally {
    fs.rename = rename;
  }
  await store.save();
  assert.equal(store.getMicrosoftClientId(), firstId);
  assertPublic(store, "ready", true);
});

test("empty masked settings preserve the ID, public flags cannot be forged and explicit clear works without encryption", async (t) => {
  const f = await fixture(t),
    store = f.create();
  await store.load();
  await store.updateSettings({ microsoftClientId: firstId });
  await store.updateSettings({
    microsoftClientId: "",
    microsoftClientIdConfigured: false,
    microsoftClientIdStorageStatus: "unreadable",
    downloadConcurrency: 7,
  });
  assert.equal(store.getMicrosoftClientId(), firstId);
  assertPublic(store, "ready", true);
  assert.equal(store.settings.downloadConcurrency, 7);
  f.control.available = false;
  await store.updateSettings({ clearMicrosoftClientId: true });
  assert.equal(store.getMicrosoftClientId(), "");
  assertPublic(store, "unavailable", false);
  assert.equal(
    JSON.parse(await fs.readFile(f.file, "utf8")).microsoftClientConfiguration,
    undefined,
  );
  const restarted = f.create();
  await restarted.load();
  assert.equal(restarted.getMicrosoftClientId(), "");
});

test("invalid replacement ID cannot overwrite working ciphertext and invalid legacy values remain recoverable", async (t) => {
  const f = await fixture(t),
    store = f.create();
  await store.load();
  await store.updateSettings({ microsoftClientId: firstId });
  const before = await fs.readFile(f.file),
    memoryBefore = store.settings.memoryMb,
    encryptions = f.control.encryptions;
  await assert.rejects(
    store.updateSettings({
      microsoftClientId: "synthetic-not-a-valid-id",
      memoryMb: 6144,
    }),
    /UUID/,
  );
  assert.equal(store.getMicrosoftClientId(), firstId);
  assert.equal(store.settings.memoryMb, memoryBefore);
  assertPublic(store, "ready", true);
  assert.equal(f.control.encryptions, encryptions);
  assert.deepEqual(await fs.readFile(f.file), before);

  const legacy = await fixture(t, {
      microsoftClientId: "synthetic-invalid-legacy",
    }),
    original = await fs.readFile(legacy.file),
    pending = legacy.create();
  await pending.load();
  assertPublic(pending, "migration-pending", false);
  assert.throws(() => pending.getMicrosoftClientId(), /安全迁移/);
  assert.deepEqual(await fs.readFile(legacy.file), original);
});
