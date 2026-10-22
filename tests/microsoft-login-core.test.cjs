const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createLauncherCore } = require("@ldfcl/core/launcher");

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const DEVICE_CODE = "private-fixture-device-code";
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function challenge(userCode = "ABCD-EFGH") {
  return new Response(
    JSON.stringify({
      device_code: DEVICE_CODE,
      user_code: userCode,
      verification_uri: "https://microsoft.com/devicelogin",
      expires_in: 600,
      interval: 60,
    }),
    { headers: { "content-type": "application/json" } },
  );
}
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-login-core-"));
  const key = crypto.randomBytes(32);
  const calls = [],
    events = [],
    requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.match(String(url), /\/consumers\/oauth2\/v2\.0\/devicecode$/);
    requests.push(new URLSearchParams(options.body));
    return overrides.fetch ? overrides.fetch(url, options) : challenge();
  };
  const secretStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString("utf8");
    },
  };
  let core;
  t.after(async () => {
    core?.dispose();
    global.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  core = await createLauncherCore({
    dataDir: path.join(root, "LDFCL-data"),
    defaultGameRoot: path.join(root, ".minecraft"),
    secretStorage,
    emit(event) {
      events.push(event);
      overrides.emit?.(event, core);
    },
    host: {
      chooseFiles: async () => ({ canceled: true, filePaths: [] }),
      chooseSaveFile: async () => ({ canceled: true }),
      openPath: async () => "",
      openExternal: async (url) => {
        calls.push(["browser", url]);
      },
      writeClipboardText: (text) => {
        calls.push(["clipboard", text]);
      },
      trashItem: async () => {},
      imageDataUrl: () => "",
      focusWindow: () => {},
      minimizeWindow: () => {},
      ...overrides.host,
    },
  });
  await core.call("settings", { microsoftClientId: CLIENT_ID });
  return { core, root, calls, events, requests };
}

test("Microsoft login privately resolves the saved ID, copies only the user code once, before opening the browser", async (t) => {
  const f = await fixture(t);
  const result = await f.core.call("account:microsoft", {
    clientId: "renderer-cannot-override-saved-id",
  });
  assert.equal(result.codeCopied, true);
  assert.equal("copyMessage" in result, false);
  assert.deepEqual(f.calls, [
    ["clipboard", "ABCD-EFGH"],
    ["browser", "https://microsoft.com/devicelogin"],
  ]);
  assert.equal(f.requests[0].get("client_id"), CLIENT_ID);
  const state = await f.core.state();
  assert.equal(state.settings.microsoftClientId, "");
  assert.equal(state.settings.microsoftClientIdConfigured, true);
  assert.equal(state.settings.microsoftClientIdStorageStatus, "ready");
  assert.equal(
    f.events.filter((e) => e.status === "waiting").at(-1).codeCopied,
    true,
  );
  const publicData = JSON.stringify({ state, result, events: f.events });
  assert.equal(publicData.includes(CLIENT_ID), false);
  assert.equal(publicData.includes(DEVICE_CODE), false);
  const disk = await fs.readFile(
    path.join(f.root, "LDFCL-data", "launcher.json"),
    "utf8",
  );
  assert.equal(disk.includes(CLIENT_ID), false);
});

for (const mode of ["unavailable", "throwing"]) {
  test(`Microsoft login survives a ${mode} clipboard with an honest manual-copy fallback`, async (t) => {
    const f = await fixture(t, {
      host: {
        writeClipboardText:
          mode === "unavailable"
            ? undefined
            : () => {
                throw Error("synthetic clipboard failure");
              },
      },
    });
    const result = await f.core.call("account:microsoft");
    assert.equal(result.codeCopied, false);
    assert.match(result.copyMessage, /未能自动复制/);
    assert.deepEqual(f.calls, [
      ["browser", "https://microsoft.com/devicelogin"],
    ]);
    const waiting = f.events.filter((e) => e.status === "waiting").at(-1);
    assert.equal(waiting.codeCopied, false);
    assert.equal(waiting.copyMessage, result.copyMessage);
  });
}

test("a cancelled request with a late device-code response cannot change the clipboard or launch a browser", async (t) => {
  const started = deferred(),
    late = deferred();
  const f = await fixture(t, {
    fetch: async () => {
      started.resolve();
      return late.promise;
    },
  });
  const pending = f.core.call("account:microsoft");
  const rejected = assert.rejects(pending, /取消/);
  await started.promise;
  await f.core.call("account:cancel");
  late.resolve(challenge("LATE-CODE"));
  await rejected;
  assert.deepEqual(f.calls, []);
});

test("a replacement login copies its own code and a superseded request cannot overwrite it", async (t) => {
  const started = deferred(),
    late = deferred();
  let count = 0;
  const f = await fixture(t, {
    fetch: async () => {
      if (++count === 1) {
        started.resolve();
        return late.promise;
      }
      return challenge("NEW1-CODE");
    },
  });
  const old = f.core.call("account:microsoft");
  const rejected = assert.rejects(old, /取消/);
  await started.promise;
  const current = await f.core.call("account:microsoft");
  late.resolve(challenge("OLD1-CODE"));
  await rejected;
  assert.equal(current.codeCopied, true);
  assert.deepEqual(f.calls, [
    ["clipboard", "NEW1-CODE"],
    ["browser", "https://microsoft.com/devicelogin"],
  ]);
});

test("cancellation delivered with the initial waiting event prevents both clipboard and browser dispatch", async (t) => {
  const f = await fixture(t, {
    emit(event, core) {
      if (event.type === "auth-status" && event.status === "waiting")
        void core.call("account:cancel");
    },
  });
  await assert.rejects(f.core.call("account:microsoft"), /取消/);
  assert.deepEqual(f.calls, []);
});

test("disposing a pending login prevents its late response from copying", async (t) => {
  const started = deferred(),
    late = deferred();
  const f = await fixture(t, {
    fetch: async () => {
      started.resolve();
      return late.promise;
    },
  });
  const pending = f.core.call("account:microsoft");
  const rejected = assert.rejects(pending, /取消/);
  await started.promise;
  f.core.dispose();
  late.resolve(challenge());
  await rejected;
  assert.deepEqual(f.calls, []);
});

test("a challenge that expires before dispatch cannot copy a stale code or open the browser", async (t) => {
  const originalNow = Date.now;
  const f = await fixture(t, {
    emit(event) {
      if (event.type === "auth-status" && event.status === "waiting") {
        const expiredTime = originalNow() + 700_000;
        Date.now = () => expiredTime;
      }
    },
  });
  try {
    await assert.rejects(f.core.call("account:microsoft"), /取消|过期/);
    assert.deepEqual(f.calls, []);
  } finally {
    Date.now = originalNow;
  }
});
