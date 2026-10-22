const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");

const storageKey = crypto.randomBytes(32);
let available = true;
const safeStorage = {
  isEncryptionAvailable: () => available,
  encryptString(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", storageKey, iv);
    const content = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), content]);
  },
  decryptString(buffer) {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      storageKey,
      buffer.subarray(0, 12),
    );
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([
      decipher.update(buffer.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  },
};
const {
  AccountService,
  offlineUuid,
  validateSkinPng,
  normalizeTextureUrl,
  MICROSOFT_REDIRECT_URI,
} = require("@ldfcl/core/services/accounts");

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-accounts-"));
  const events = [];
  const service = new AccountService(dir, (event) => events.push(event), {
    microsoftPort: 0,
    secretStorage: safeStorage,
    ...options,
  });
  t.after(async () => {
    service.cancelMicrosoft();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    events,
    service,
  };
}

test("offline UUID matches Java nameUUIDFromBytes and enforces valid Minecraft names", async (t) => {
  assert.equal(offlineUuid("Notch"), "b50ad385829d3141a2167e7d7539ba7f");
  const { service } = await fixture(t);
  await assert.rejects(service.addOffline("中文名字"), /3–16/);
  await assert.rejects(service.addOffline("../player"), /3–16/);
  const first = await service.addOffline("Notch");
  const duplicate = await service.addOffline("Notch");
  assert.equal(first.id, duplicate.id);
  assert.equal((await service.list()).length, 1);
});

test("skin header validation rejects non-PNG and unsupported skin dimensions", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(64, 20);
  assert.doesNotThrow(() => validateSkinPng(png));
  png.writeUInt32BE(32, 20);
  assert.doesNotThrow(() => validateSkinPng(png));
  png.writeUInt32BE(128, 16);
  assert.throws(() => validateSkinPng(png), /64/);
  assert.throws(() => validateSkinPng(Buffer.from("not a png")), /PNG/);
});

test("Mojang HTTP texture properties upgrade to HTTPS for the renderer CSP", () => {
  assert.equal(
    normalizeTextureUrl("http://textures.minecraft.net/texture/test"),
    "https://textures.minecraft.net/texture/test",
  );
  assert.equal(
    normalizeTextureUrl("https://skin.example.com/skin.png"),
    "https://skin.example.com/skin.png",
  );
  assert.equal(normalizeTextureUrl("javascript:alert(1)"), undefined);
  assert.equal(
    normalizeTextureUrl("https://user:password@skin.example.com/skin.png"),
    undefined,
  );
});

test("Yggdrasil tokens are encrypted on disk and excluded from public accounts/events", async (t) => {
  const { service, dir, events } = await fixture(t);
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url) => {
    assert.match(String(url), /\/authserver\/authenticate$/);
    return new Response(
      JSON.stringify({
        selectedProfile: {
          id: "0123456789abcdef0123456789abcdef",
          name: "SkinUser",
        },
        accessToken: "test-access-secret",
        clientToken: "test-client-secret",
      }),
      { status: 200 },
    );
  };
  const account = await service.addYggdrasil({
    server: "https://skin.example.com/api/yggdrasil",
    username: "mail@example.com",
    password: "test-password-secret",
  });
  assert.equal(account.accessToken, undefined);
  assert.equal(account.clientToken, undefined);
  assert(!JSON.stringify(await service.list()).includes("secret"));
  assert(!JSON.stringify(events).includes("secret"));
  const disk = await fs.readFile(path.join(dir, "accounts.json"), "utf8");
  assert(!disk.includes("test-access-secret"));
  assert(!disk.includes("test-password-secret"));
  assert(JSON.parse(disk)[0].encryptedSecrets);
  const reloaded = new AccountService(dir, () => {}, {
    secretStorage: safeStorage,
  });
  assert.equal((await reloaded.list())[0].name, "SkinUser");
  await reloaded.remove(account.id);
  assert.equal((await reloaded.list()).length, 0);
});

test("safeStorage unavailable retains account metadata without persisting tokens", async (t) => {
  const { service, dir, events } = await fixture(t);
  const originalFetch = global.fetch;
  available = false;
  t.after(() => {
    global.fetch = originalFetch;
    available = true;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        selectedProfile: { id: "profile", name: "MemoryUser" },
        accessToken: "never-write-this-token",
        clientToken: "never-write-this-client",
      }),
      { status: 200 },
    );
  await service.addYggdrasil({
    server: "https://skin.example.com",
    username: "test",
    password: "password",
  });
  const disk = await fs.readFile(path.join(dir, "accounts.json"), "utf8");
  assert(!disk.includes("never-write"));
  assert(!disk.includes("encryptedSecrets"));
  assert(events.some((event) => event.status === "warning"));
});

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

function loopbackRequest(url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const request = http.request(
      url,
      {
        method: options.method ?? "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(data),
          Connection: "close",
          ...options.headers,
        },
        agent: false,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            text,
            headers: response.headers,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(data);
  });
}

async function waitForEvent(events, status, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = events.find(
      (event) => event.type === "auth-status" && event.status === status,
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Missing auth-status ${status}`);
}

function mockMicrosoftServices(t, options = {}) {
  const previous = global.fetch,
    calls = [];
  t.after(() => {
    global.fetch = previous;
  });
  global.fetch = async (url, init = {}) => {
    const endpoint = String(url);
    calls.push({ endpoint, init });
    if (options.respond) {
      const result = await options.respond(endpoint, init, calls);
      if (result) return result;
    }
    let body;
    if (endpoint.endsWith("/oauth2/v2.0/devicecode")) {
      body = {
        device_code: "test-device-code-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 600,
        interval: 5,
        ...options.deviceChallenge,
      };
    } else if (endpoint.endsWith("/oauth2/v2.0/token")) {
      if (options.tokenDelay) return options.tokenDelay(init);
      body = {
        access_token: "test-microsoft-secret",
        refresh_token: "test-refresh-secret",
        expires_in: 3600,
      };
    } else if (
      endpoint === "https://user.auth.xboxlive.com/user/authenticate"
    ) {
      assert.equal(
        JSON.parse(init.body).Properties.RpsTicket,
        "d=test-microsoft-secret",
      );
      body = {
        Token: "test-xbl-secret",
        DisplayClaims: { xui: [{ uhs: "test-uhs" }] },
      };
    } else if (endpoint === "https://xsts.auth.xboxlive.com/xsts/authorize") {
      const input = JSON.parse(init.body);
      assert.equal(input.RelyingParty, "rp://api.minecraftservices.com/");
      assert.deepEqual(input.Properties.UserTokens, ["test-xbl-secret"]);
      body = {
        Token: "test-xsts-secret",
        DisplayClaims: { xui: [{ uhs: "test-uhs" }] },
      };
    } else if (
      endpoint ===
      "https://api.minecraftservices.com/authentication/login_with_xbox"
    ) {
      assert.equal(
        JSON.parse(init.body).identityToken,
        "XBL3.0 x=test-uhs;test-xsts-secret",
      );
      body = { access_token: "test-minecraft-secret", expires_in: 86400 };
    } else if (
      endpoint === "https://api.minecraftservices.com/entitlements/mcstore"
    ) {
      assert.equal(init.headers.Authorization, "Bearer test-minecraft-secret");
      body = { items: [{ name: "game_minecraft" }] };
    } else if (
      endpoint === "https://api.minecraftservices.com/minecraft/profile"
    ) {
      body = {
        id: "0123456789abcdef0123456789abcdef",
        name: "BrowserPlayer",
        skins: [
          {
            id: "skin",
            state: "ACTIVE",
            variant: "CLASSIC",
            url: "http://textures.minecraft.net/texture/example",
          },
        ],
        capes: [],
      };
    } else throw new Error(`Unexpected mocked endpoint: ${endpoint}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return calls;
}

function parseChallenge(challenge) {
  const url = new URL(challenge.authorizationUrl);
  return {
    url,
    callback: url.searchParams.get("redirect_uri"),
    state: url.searchParams.get("state"),
  };
}

test("Microsoft browser authorization uses own app ID, PKCE S256, form_post and loopback", async (t) => {
  const { service, events } = await fixture(t);
  await assert.rejects(service.beginMicrosoft("invalid"), /应用 ID/);
  assert.equal(MICROSOFT_REDIRECT_URI, "http://127.0.0.1:45329/oauth/callback");
  const challenge = await service.beginMicrosoft(CLIENT_ID);
  const { url, callback, state } = parseChallenge(challenge);
  assert.equal(challenge.flow, "browser");
  assert.equal(challenge.expiresIn, 300);
  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("response_mode"), "form_post");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(new URL(callback).hostname, "127.0.0.1");
  assert.equal(service.microsoftSession.server.address().address, "127.0.0.1");
  assert(state.length >= 43);
  assert(url.searchParams.get("code_challenge").length >= 43);
  assert.equal(url.searchParams.get("code_verifier"), null);
  assert.equal(url.searchParams.get("client_secret"), null);
  const stray = await loopbackRequest(callback, {}, { method: "GET" });
  assert.equal(stray.status, 405);
  service.cancelMicrosoft();
  assert(events.some((event) => event.status === "cancelled"));
  await assert.rejects(loopbackRequest(callback, { state, code: "late-code" }));
});

test("real loopback rejects wrong state, redeems valid code once, and persists no OAuth/XSTS plaintext", async (t) => {
  const { service, events, dir } = await fixture(t);
  const calls = mockMicrosoftServices(t);
  const { url, callback, state } = parseChallenge(
    await service.beginMicrosoft(CLIENT_ID),
  );
  const rejected = await loopbackRequest(callback, {
    state: "wrong-state",
    code: "test-auth-code-secret",
  });
  assert.equal(rejected.status, 403);
  assert.equal(calls.length, 0);
  const response = await loopbackRequest(callback, {
    state,
    code: "test-auth-code-secret",
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers["cache-control"],
    "no-store, no-cache, must-revalidate",
  );
  assert(!response.text.includes("test-auth-code-secret"));
  const success = await waitForEvent(events, "success");
  assert.equal(success.account.name, "BrowserPlayer");
  assert.equal(success.account.accessToken, undefined);
  assert.equal(
    success.account.skins[0].url,
    "https://textures.minecraft.net/texture/example",
  );
  const tokenCall = calls.find((call) =>
    call.endpoint.endsWith("/oauth2/v2.0/token"),
  );
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "test-auth-code-secret");
  assert.equal(form.get("redirect_uri"), callback);
  assert.equal(form.get("client_id"), CLIENT_ID);
  assert.equal(
    crypto
      .createHash("sha256")
      .update(form.get("code_verifier"))
      .digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  assert.equal(form.get("client_secret"), null);
  await assert.rejects(
    loopbackRequest(callback, { state, code: "test-auth-code-secret" }),
  );
  assert.equal(
    calls.filter((call) => call.endpoint.endsWith("/oauth2/v2.0/token")).length,
    1,
  );
  const publicText =
    JSON.stringify(events) + JSON.stringify(await service.list());
  const disk = await fs.readFile(path.join(dir, "accounts.json"), "utf8");
  for (const secret of [
    "test-microsoft-secret",
    "test-refresh-secret",
    "test-xbl-secret",
    "test-xsts-secret",
    "test-minecraft-secret",
    "test-auth-code-secret",
    form.get("code_verifier"),
  ]) {
    assert(!publicText.includes(secret));
    assert(!disk.includes(secret));
  }
  assert.equal(service.microsoftSession, undefined);
});

test("Microsoft browser cancellation aborts the exchange and prevents late account creation", async (t) => {
  const { service, events } = await fixture(t);
  let exchangeSignal;
  mockMicrosoftServices(t, {
    tokenDelay: (init) =>
      new Promise((_resolve, reject) => {
        exchangeSignal = init.signal;
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  const { callback, state } = parseChallenge(
    await service.beginMicrosoft(CLIENT_ID),
  );
  assert.equal(
    (await loopbackRequest(callback, { state, code: "pending-code" })).status,
    200,
  );
  service.cancelMicrosoft();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(exchangeSignal.aborted, true);
  assert.equal((await service.list()).length, 0);
  assert(!events.some((event) => event.status === "success"));
});

test("Microsoft browser timeout closes its loopback listener", async (t) => {
  const { service, events } = await fixture(t, { microsoftTimeoutMs: 60 });
  const { callback, state } = parseChallenge(
    await service.beginMicrosoft(CLIENT_ID),
  );
  await waitForEvent(events, "expired");
  assert.equal(service.microsoftSession, undefined);
  await assert.rejects(loopbackRequest(callback, { state, code: "late-code" }));
});

test("Microsoft callback listener rejects oversized forms without consuming the pending login", async (t) => {
  const { service, events } = await fixture(t);
  const calls = mockMicrosoftServices(t);
  const { callback, state } = parseChallenge(
    await service.beginMicrosoft(CLIENT_ID),
  );
  const oversized = await loopbackRequest(callback, {
    state,
    code: "x".repeat(20_000),
  });
  assert.equal(oversized.status, 413);
  assert.equal(calls.length, 0);
  const valid = await loopbackRequest(callback, { state, code: "valid-code" });
  assert.equal(valid.status, 200);
  await waitForEvent(events, "success");
});

test("Microsoft fixed callback port conflicts fail without falling back to an unregistered URI", async (t) => {
  const occupied = http.createServer((_request, response) => response.end());
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const { service } = await fixture(t, {
    microsoftPort: occupied.address().port,
  });
  await assert.rejects(service.beginMicrosoft(CLIENT_ID), /回调端口.*正在使用/);
  assert.equal(service.microsoftSession, undefined);
});

test("Microsoft denial ends the flow without exposing provider error descriptions", async (t) => {
  const { service, events } = await fixture(t);
  const calls = mockMicrosoftServices(t);
  const { callback, state } = parseChallenge(
    await service.beginMicrosoft(CLIENT_ID),
  );
  const response = await loopbackRequest(callback, {
    state,
    error: "access_denied",
    error_description: "untrusted-private-description",
  });
  assert.equal(response.status, 400);
  const failure = await waitForEvent(events, "error");
  assert.match(failure.message, /取消或拒绝/);
  assert(!JSON.stringify(events).includes("untrusted-private-description"));
  assert(!response.text.includes("untrusted-private-description"));
  assert.equal(calls.length, 0);
  assert.equal(service.microsoftSession, undefined);
});

test("Microsoft browser-created accounts retain refresh-token launch support", async (t) => {
  const { service, events, dir } = await fixture(t);
  const calls = mockMicrosoftServices(t);
  const { callback, state } = parseChallenge(
    await service.beginMicrosoft(CLIENT_ID),
  );
  await loopbackRequest(callback, { state, code: "valid-code" });
  const success = await waitForEvent(events, "success");
  const file = path.join(dir, "accounts.json");
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  stored[0].expiresAt = 0;
  await fs.writeFile(file, JSON.stringify(stored));
  const reloaded = new AccountService(dir, () => {}, {
    secretStorage: safeStorage,
  });
  const account = await reloaded.getForLaunch(success.account.id);
  assert.equal(account.accessToken, "test-minecraft-secret");
  assert.equal((await reloaded.list()).length, 1);
  const refresh = calls
    .filter((call) => call.endpoint.endsWith("/oauth2/v2.0/token"))
    .map((call) => new URLSearchParams(call.init.body))
    .find((form) => form.get("grant_type") === "refresh_token");
  assert(refresh);
  assert.equal(refresh.get("refresh_token"), "test-refresh-secret");
  assert.equal(refresh.get("client_id"), CLIENT_ID);
  assert.equal(refresh.get("client_secret"), null);
});

test("Yggdrasil rejects non-HTTPS password submission to remote servers", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    service.addYggdrasil({
      server: "http://skin.example.com",
      username: "test",
      password: "secret",
    }),
    /HTTPS/,
  );
});

function virtualDeviceClock() {
  let now = 0;
  const sleeps = [];
  return {
    sleeps,
    clock: {
      now: () => now,
      async sleep(ms, signal) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        sleeps.push(ms);
        now += ms;
        await new Promise((resolve) => setImmediate(resolve));
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      },
    },
  };
}

function oauthError(error, status = 400) {
  return new Response(
    JSON.stringify({
      error,
      error_description: "private-provider-description",
    }),
    { status },
  );
}

test("Microsoft device flow uses only own public app ID, honors polling intervals and encrypts launch refresh tokens", async (t) => {
  const { clock, sleeps } = virtualDeviceClock();
  const { service, events, dir } = await fixture(t, { deviceClock: clock });
  const calls = mockMicrosoftServices(t);
  await assert.rejects(service.beginMicrosoftDevice("invalid"), /应用 ID/);
  assert.equal(calls.length, 0);
  const challenge = await service.beginMicrosoftDevice(CLIENT_ID);
  assert.deepEqual(challenge, {
    flow: "device",
    verificationUri: "https://microsoft.com/devicelogin",
    userCode: "ABCD-EFGH",
    expiresIn: 600,
    interval: 5,
  });
  const success = await waitForEvent(events, "success");
  assert.equal(success.flow, "device");
  assert.equal(success.account.name, "BrowserPlayer");
  assert.equal(success.account.accessToken, undefined);
  assert.deepEqual(sleeps, [5000]);
  assert.equal(
    events.find((event) => event.status === "waiting").userCode,
    "ABCD-EFGH",
  );
  assert(
    events.some(
      (event) => event.flow === "device" && event.status === "authenticating",
    ),
  );
  const issuance = new URLSearchParams(calls[0].init.body);
  assert.equal(issuance.get("client_id"), CLIENT_ID);
  assert.equal(issuance.get("scope"), "XboxLive.signin offline_access");
  const form = new URLSearchParams(calls[1].init.body);
  assert.equal(
    form.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:device_code",
  );
  assert.equal(form.get("device_code"), "test-device-code-secret");
  assert.equal(form.get("client_id"), CLIENT_ID);
  for (const call of calls.slice(0, 2)) {
    const input = new URLSearchParams(call.init.body);
    assert.equal(input.get("client_secret"), null);
    assert.equal(input.get("redirect_uri"), null);
    assert.equal(call.init.redirect, "error");
  }
  const file = path.join(dir, "accounts.json");
  const disk = await fs.readFile(file, "utf8");
  const publicText =
    JSON.stringify(challenge) +
    JSON.stringify(events) +
    JSON.stringify(await service.list());
  for (const secret of [
    "test-device-code-secret",
    "test-microsoft-secret",
    "test-refresh-secret",
    "test-xbl-secret",
    "test-xsts-secret",
    "test-minecraft-secret",
  ]) {
    assert(!publicText.includes(secret));
    assert(!disk.includes(secret));
  }
  assert.equal(service.microsoftDeviceSession, undefined);
  const stored = JSON.parse(disk);
  stored[0].expiresAt = 0;
  await fs.writeFile(file, JSON.stringify(stored));
  const reloaded = new AccountService(dir, () => {}, {
    secretStorage: safeStorage,
  });
  const launched = await reloaded.getForLaunch(success.account.id);
  assert.equal(launched.accessToken, "test-minecraft-secret");
  const refresh = calls
    .filter((call) => call.endpoint.endsWith("/token"))
    .map((call) => new URLSearchParams(call.init.body))
    .find((input) => input.get("grant_type") === "refresh_token");
  assert.equal(refresh.get("refresh_token"), "test-refresh-secret");
  assert.equal(refresh.get("client_id"), CLIENT_ID);
});

test("device pending retains interval and each slow_down permanently adds five seconds", async (t) => {
  const { clock, sleeps } = virtualDeviceClock();
  const { service, events } = await fixture(t, { deviceClock: clock });
  const replies = ["authorization_pending", "slow_down", "slow_down"];
  mockMicrosoftServices(t, {
    respond(endpoint) {
      if (endpoint.endsWith("/token") && replies.length)
        return oauthError(replies.shift());
    },
  });
  await service.beginMicrosoftDevice(CLIENT_ID);
  await waitForEvent(events, "success");
  assert.deepEqual(sleeps, [5000, 5000, 10000, 15000]);
});

test("device polling defaults to five seconds and accepts a server interval of one second", async (t) => {
  for (const [interval, expected] of [
    [undefined, 5000],
    [1, 1000],
  ]) {
    await t.test(`interval ${interval ?? "default"}`, async (subtest) => {
      const { clock, sleeps } = virtualDeviceClock();
      const { service, events } = await fixture(subtest, {
        deviceClock: clock,
      });
      mockMicrosoftServices(subtest, { deviceChallenge: { interval } });
      const challenge = await service.beginMicrosoftDevice(CLIENT_ID);
      await waitForEvent(events, "success");
      assert.equal(challenge.interval * 1000, expected);
      assert.deepEqual(sleeps, [expected]);
    });
  }
});

test("device polling backs off network failures without losing the public challenge or extending expiration", async (t) => {
  const { clock, sleeps } = virtualDeviceClock();
  const { service, events } = await fixture(t, { deviceClock: clock });
  let poll = 0;
  mockMicrosoftServices(t, {
    respond(endpoint) {
      if (!endpoint.endsWith("/token")) return;
      poll++;
      if (poll <= 2) throw new TypeError("private-network-details");
      if (poll === 3) return oauthError("authorization_pending");
    },
  });
  await service.beginMicrosoftDevice(CLIENT_ID);
  await waitForEvent(events, "success");
  assert.deepEqual(sleeps, [5000, 10000, 20000, 5000]);
  const waiting = events.filter((event) => event.status === "waiting");
  assert.deepEqual(
    waiting.map((event) => event.expiresIn),
    [600, 595, 585],
  );
  for (const event of waiting) {
    assert.equal(event.flow, "device");
    assert.equal(event.userCode, "ABCD-EFGH");
    assert.equal(event.verificationUri, "https://microsoft.com/devicelogin");
    assert.equal(event.interval, 5);
  }
  assert(!JSON.stringify(events).includes("private-network-details"));
});

test("transient HTTP 429 and 503 responses also back off device polling", async (t) => {
  const { clock, sleeps } = virtualDeviceClock();
  const { service, events } = await fixture(t, { deviceClock: clock });
  const statuses = [429, 503];
  mockMicrosoftServices(t, {
    respond(endpoint) {
      if (endpoint.endsWith("/token") && statuses.length)
        return oauthError("unavailable", statuses.shift());
    },
  });
  await service.beginMicrosoftDevice(CLIENT_ID);
  await waitForEvent(events, "success");
  assert.deepEqual(sleeps, [5000, 10000, 20000]);
});

test("HTTP 429 slow_down still permanently adds five seconds", async (t) => {
  const { clock, sleeps } = virtualDeviceClock();
  const { service, events } = await fixture(t, { deviceClock: clock });
  let poll = 0;
  mockMicrosoftServices(t, {
    respond(endpoint) {
      if (!endpoint.endsWith("/token")) return;
      poll++;
      if (poll === 1) return oauthError("slow_down", 429);
      if (poll === 2) return oauthError("authorization_pending");
    },
  });
  await service.beginMicrosoftDevice(CLIENT_ID);
  await waitForEvent(events, "success");
  assert.deepEqual(sleeps, [5000, 10000, 10000]);
});

test("initial device challenge subtracts HTTP issuance time from its expiration", async (t) => {
  let now = 0;
  const { service } = await fixture(t, {
    deviceClock: {
      now: () => now,
      sleep(_ms, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    },
  });
  mockMicrosoftServices(t, {
    respond(endpoint) {
      if (endpoint.endsWith("/devicecode")) now += 2500;
    },
  });
  const challenge = await service.beginMicrosoftDevice(CLIENT_ID);
  assert.equal(challenge.expiresIn, 598);
});

test("device rejection, invalid codes and server expiration terminate without exposing provider details", async (t) => {
  for (const [error, expected] of [
    ["authorization_declined", "error"],
    ["access_denied", "error"],
    ["bad_verification_code", "error"],
    ["invalid_grant", "error"],
    ["invalid_client", "error"],
    ["expired_token", "expired"],
  ]) {
    await t.test(error, async (subtest) => {
      const { clock, sleeps } = virtualDeviceClock();
      const { service, events } = await fixture(subtest, {
        deviceClock: clock,
      });
      const calls = mockMicrosoftServices(subtest, {
        respond: (endpoint) =>
          endpoint.endsWith("/token") ? oauthError(error) : undefined,
      });
      await service.beginMicrosoftDevice(CLIENT_ID);
      await waitForEvent(events, expected);
      assert.deepEqual(sleeps, [5000]);
      assert.equal(calls.length, 2);
      assert.equal((await service.list()).length, 0);
      assert.equal(service.microsoftDeviceSession, undefined);
      assert(!JSON.stringify(events).includes(error));
      assert(!JSON.stringify(events).includes("private-provider-description"));
    });
  }
});

test("device challenge rejects untrusted verification links and malformed fields before any polling", async (t) => {
  const invalid = [
    { verification_uri: "http://microsoft.com/devicelogin" },
    { verification_uri: "https://microsoft.com.evil.example/device" },
    { verification_uri: "https://evil.example/device" },
    { verification_uri: "https://user:password@microsoft.com/devicelogin" },
    { verification_uri: "https://microsoft.com:8443/devicelogin" },
    { verification_uri: "javascript:alert(1)" },
    { verification_uri: "https://microsoft.com/devicelogin?code=private" },
    { device_code: "short" },
    { device_code: "private\ncode" },
    { user_code: "<untrusted-html>" },
    { expires_in: 0 },
    { expires_in: 3601 },
    { expires_in: "600" },
    { interval: 0 },
    { interval: 1.5 },
    { interval: 301 },
  ];
  for (const fields of invalid) {
    await t.test(JSON.stringify(fields), async (subtest) => {
      const { service, events } = await fixture(subtest);
      const calls = mockMicrosoftServices(subtest, { deviceChallenge: fields });
      await assert.rejects(
        service.beginMicrosoftDevice(CLIENT_ID),
        /Microsoft/,
      );
      assert.equal(calls.length, 1);
      assert.equal(service.microsoftDeviceSession, undefined);
      assert(
        !events.some(
          (event) => event.status === "waiting" || event.status === "success",
        ),
      );
      assert(!JSON.stringify(events).includes("test-device-code-secret"));
    });
  }
});

test("device local expiration stops polling before its next permitted request", async (t) => {
  const { clock, sleeps } = virtualDeviceClock();
  const { service, events } = await fixture(t, { deviceClock: clock });
  const calls = mockMicrosoftServices(t, {
    deviceChallenge: { expires_in: 6 },
    respond: (endpoint) =>
      endpoint.endsWith("/token")
        ? oauthError("authorization_pending")
        : undefined,
  });
  await service.beginMicrosoftDevice(CLIENT_ID);
  await waitForEvent(events, "expired");
  assert.deepEqual(sleeps, [5000, 1000]);
  assert.equal(calls.length, 2);
  assert.equal((await service.list()).length, 0);
});

test("independent device expiration aborts a hung token request", async (t) => {
  const { service, events } = await fixture(t, {
    deviceClock: { now: () => 0, sleep: async () => {} },
  });
  let signal;
  mockMicrosoftServices(t, {
    deviceChallenge: { expires_in: 1, interval: 1 },
    tokenDelay(init) {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  await service.beginMicrosoftDevice(CLIENT_ID);
  await waitForEvent(events, "expired", 2000);
  assert.equal(signal.aborted, true);
  assert.equal((await service.list()).length, 0);
  assert(
    !events.some(
      (event) => event.status === "success" || event.status === "error",
    ),
  );
});

test("device cancellation aborts issuance, token polling and Xbox exchange with no late account", async (t) => {
  for (const stage of [
    "/devicecode",
    "/token",
    "https://user.auth.xboxlive.com/user/authenticate",
  ]) {
    await t.test(stage, async (subtest) => {
      const { clock } = virtualDeviceClock();
      const { service, events } = await fixture(subtest, {
        deviceClock: clock,
      });
      let exchangeSignal, entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      mockMicrosoftServices(subtest, {
        respond(endpoint, init) {
          if (
            !(stage.startsWith("https:")
              ? endpoint === stage
              : endpoint.endsWith(stage))
          )
            return;
          exchangeSignal = init.signal;
          entered();
          // Ignore cancellation deliberately; the flow must guard late responses too.
          return new Promise((resolve) => {
            exchangeSignal.addEventListener(
              "abort",
              () =>
                resolve(
                  new Response(
                    JSON.stringify({
                      device_code: "test-device-code-secret",
                      user_code: "ABCD-EFGH",
                      verification_uri: "https://microsoft.com/devicelogin",
                      expires_in: 600,
                      interval: 5,
                      access_token: "test-microsoft-secret",
                      Token: "test-xbl-secret",
                      DisplayClaims: { xui: [{ uhs: "test-uhs" }] },
                    }),
                    { status: 200 },
                  ),
                ),
              { once: true },
            );
          });
        },
      });
      const begin = service.beginMicrosoftDevice(CLIENT_ID);
      await started;
      service.cancelMicrosoft();
      if (stage === "/devicecode") await assert.rejects(begin, /取消/);
      else await begin;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exchangeSignal.aborted, true);
      assert.equal((await service.list()).length, 0);
      assert(
        !events.some(
          (event) => event.type === "account" || event.status === "success",
        ),
      );
      assert(
        events.some(
          (event) => event.flow === "device" && event.status === "cancelled",
        ),
      );
    });
  }
});

test("cancel during secure account write leaves neither an account nor credentials on disk", async (t) => {
  const { clock } = virtualDeviceClock();
  const { service, events, dir } = await fixture(t, { deviceClock: clock });
  mockMicrosoftServices(t);
  await service.list();
  const previousWrite = fs.writeFile;
  let writeStarted, releaseWrite;
  const started = new Promise((resolve) => {
    writeStarted = resolve;
  });
  const released = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  fs.writeFile = async function (file, ...args) {
    if (String(file) === path.join(dir, "accounts.json.tmp")) {
      writeStarted();
      await released;
    }
    return previousWrite.call(this, file, ...args);
  };
  t.after(() => {
    fs.writeFile = previousWrite;
  });
  await service.beginMicrosoftDevice(CLIENT_ID);
  await started;
  service.cancelMicrosoft();
  releaseWrite();
  await service.writeQueue;
  assert.equal((await service.list()).length, 0);
  assert(
    !events.some(
      (event) => event.type === "account" || event.status === "success",
    ),
  );
  await assert.rejects(fs.access(path.join(dir, "accounts.json")), /ENOENT/);
  await assert.rejects(
    fs.access(path.join(dir, "accounts.json.tmp")),
    /ENOENT/,
  );
});

test("starting either Microsoft flow cancels the other and closes the old browser listener", async (t) => {
  let sleepSignal;
  const { service, events } = await fixture(t, {
    deviceClock: {
      now: Date.now,
      sleep(_ms, signal) {
        sleepSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    },
  });
  mockMicrosoftServices(t);
  const browser = parseChallenge(await service.beginMicrosoft(CLIENT_ID));
  await service.beginMicrosoftDevice(CLIENT_ID);
  await assert.rejects(
    loopbackRequest(browser.callback, { state: browser.state, code: "late" }),
  );
  assert.equal(service.microsoftSession, undefined);
  const nextBrowser = await service.beginMicrosoft(CLIENT_ID);
  assert.equal(nextBrowser.flow, "browser");
  assert.equal(sleepSignal.aborted, true);
  assert.equal(service.microsoftDeviceSession, undefined);
  assert(
    events.some(
      (event) => event.flow === "device" && event.status === "cancelled",
    ),
  );
});

test("cancelling before account loading completes cannot start a later device or browser flow", async (t) => {
  const { service } = await fixture(t);
  await service.list();
  const calls = mockMicrosoftServices(t);
  for (const method of ["beginMicrosoftDevice", "beginMicrosoft"]) {
    let releaseReady;
    service.ready = new Promise((resolve) => {
      releaseReady = resolve;
    });
    const attempt = service[method](CLIENT_ID);
    service.cancelMicrosoft();
    releaseReady();
    await assert.rejects(attempt, /取消/);
    assert.equal(service.microsoftDeviceSession, undefined);
    assert.equal(service.microsoftSession, undefined);
  }
  assert.equal(calls.length, 0);
});

test("disabled TLS verification refuses account requests and both Microsoft flows without calling fetch", async (t) => {
  const { service, events } = await fixture(t);
  const calls = mockMicrosoftServices(t);
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  });
  for (const begin of ["beginMicrosoftDevice", "beginMicrosoft"])
    await assert.rejects(service[begin](CLIENT_ID), /删除此环境变量并重新启动/);
  await assert.rejects(
    service.addYggdrasil({
      server: "https://skin.example.com",
      username: "player",
      password: "private-password",
    }),
    /NODE_TLS_REJECT_UNAUTHORIZED=0/,
  );
  assert.equal(calls.length, 0);
  assert.equal((await service.list()).length, 0);
  assert(!events.some((event) => event.status === "success"));
});

test("certificate validation failures stop device polling instead of retrying", async (t) => {
  const { clock, sleeps } = virtualDeviceClock();
  const { service, events } = await fixture(t, { deviceClock: clock });
  const calls = mockMicrosoftServices(t, {
    respond(endpoint) {
      if (endpoint.endsWith("/token")) {
        const error = new TypeError("private-certificate-details");
        error.cause = { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" };
        throw error;
      }
    },
  });
  await service.beginMicrosoftDevice(CLIENT_ID);
  const failure = await waitForEvent(events, "error");
  assert.match(failure.message, /HTTPS 证书验证失败，已停止登录/);
  assert(!JSON.stringify(events).includes("private-certificate-details"));
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [5000]);
  assert.equal(service.microsoftDeviceSession, undefined);
  assert.equal((await service.list()).length, 0);
});

test("changing TLS environment during a device flow prevents the next token request", async (t) => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  });
  const { service, events } = await fixture(t, {
    deviceClock: {
      now: () => 0,
      async sleep() {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      },
    },
  });
  const calls = mockMicrosoftServices(t);
  await service.beginMicrosoftDevice(CLIENT_ID);
  const failure = await waitForEvent(events, "error");
  assert.match(failure.message, /删除此环境变量并重新启动/);
  assert.equal(calls.length, 1);
  assert.equal((await service.list()).length, 0);
  assert(!events.some((event) => event.status === "success"));
});

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

async function microsoftFixture(t, respond) {
  const { clock } = virtualDeviceClock();
  const context = await fixture(t, { deviceClock: clock });
  const calls = mockMicrosoftServices(t, { respond });
  await context.service.beginMicrosoftDevice(CLIENT_ID);
  const { account } = await waitForEvent(context.events, "success");
  return { ...context, account, calls };
}

async function assertAccountRemoved(service, dir, events, id, eventIndex) {
  assert(!(await service.list()).some((account) => account.id === id));
  const disk = JSON.parse(
    await fs.readFile(path.join(dir, "accounts.json"), "utf8"),
  );
  assert(!disk.some((account) => account.id === id));
  assert(
    !events
      .slice(eventIndex)
      .some((event) => event.type === "account" && event.account.id === id),
  );
  const reloaded = new AccountService(dir, () => {}, {
    secretStorage: safeStorage,
  });
  assert(!(await reloaded.list()).some((account) => account.id === id));
}

test("removal invalidates a shared Yggdrasil refresh without restoring the account or disturbing another account", async (t) => {
  const { service, dir, events } = await fixture(t);
  const started = deferred(),
    release = deferred();
  const previousFetch = global.fetch;
  t.after(() => {
    global.fetch = previousFetch;
    release.resolve();
  });
  let refreshes = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith("/authenticate"))
      return jsonResponse({
        selectedProfile: { id: "skin-player", name: "SkinPlayer" },
        accessToken: "old-skin-token",
        clientToken: "skin-client",
      });
    if (String(url).endsWith("/validate")) return jsonResponse({}, 403);
    if (String(url).endsWith("/refresh")) {
      refreshes++;
      started.resolve();
      await release.promise;
      return jsonResponse({ accessToken: "late-skin-token" });
    }
    throw new Error(`Unexpected endpoint ${url}`);
  };
  const account = await service.addYggdrasil({
    server: "https://skin.example.com",
    username: "player",
    password: "password",
  });
  const other = await service.addOffline("OtherPlayer");
  const first = assert.rejects(
    service.getForLaunch(account.id),
    /已移除或重新登录/,
  );
  const second = assert.rejects(
    service.getForLaunch(account.id),
    /已移除或重新登录/,
  );
  await started.promise;
  await service.remove(account.id);
  const eventIndex = events.length;
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(refreshes, 1);
  assert.equal((await service.list())[0].id, other.id);
  await assertAccountRemoved(service, dir, events, account.id, eventIndex);
});

test("removal while a Microsoft refresh is pending rejects late credentials and does not begin Xbox exchange", async (t) => {
  const started = deferred(),
    release = deferred();
  let blockRefresh = false;
  const { service, dir, events, account, calls } = await microsoftFixture(
    t,
    async (endpoint, init) => {
      if (blockRefresh && endpoint.endsWith("/token")) {
        assert.equal(
          new URLSearchParams(init.body).get("grant_type"),
          "refresh_token",
        );
        started.resolve();
        await release.promise;
        return jsonResponse({
          access_token: "late-ms-token",
          refresh_token: "late-ms-refresh",
        });
      }
    },
  );
  const file = path.join(dir, "accounts.json");
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  stored[0].expiresAt = 0;
  await fs.writeFile(file, JSON.stringify(stored));
  const reloaded = new AccountService(dir, (event) => events.push(event), {
    secretStorage: safeStorage,
  });
  t.after(() => {
    release.resolve();
    reloaded.cancelMicrosoft();
  });
  blockRefresh = true;
  const pending = assert.rejects(
    reloaded.getForLaunch(account.id),
    /已移除或重新登录/,
  );
  await started.promise;
  await reloaded.remove(account.id);
  const eventIndex = events.length,
    callCount = calls.length;
  release.resolve();
  await pending;
  assert.equal(calls.length, callCount);
  await assertAccountRemoved(reloaded, dir, events, account.id, eventIndex);
});

test("a late Microsoft appearance response cannot restore a removed account", async (t) => {
  const started = deferred(),
    release = deferred();
  let blockProfile = false;
  const { service, dir, events, account } = await microsoftFixture(
    t,
    async (endpoint) => {
      if (blockProfile && endpoint.endsWith("/minecraft/profile")) {
        started.resolve();
        await release.promise;
        return jsonResponse({
          id: "0123456789abcdef0123456789abcdef",
          name: "LatePlayer",
          skins: [],
          capes: [],
        });
      }
    },
  );
  t.after(() => release.resolve());
  blockProfile = true;
  const pending = assert.rejects(
    service.profile(account.id),
    /已移除或重新登录/,
  );
  await started.promise;
  await service.remove(account.id);
  const eventIndex = events.length;
  release.resolve();
  await pending;
  await assertAccountRemoved(service, dir, events, account.id, eventIndex);
});

test("re-signing into a Yggdrasil account invalidates old refresh work and releases its launch cache", async (t) => {
  const { service, dir } = await fixture(t);
  const started = deferred(),
    release = deferred();
  const previousFetch = global.fetch;
  t.after(() => {
    global.fetch = previousFetch;
    release.resolve();
  });
  let logins = 0;
  global.fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/authenticate"))
      return jsonResponse({
        selectedProfile: {
          id: "same-player",
          name: ++logins === 1 ? "OldPlayer" : "NewPlayer",
        },
        accessToken: logins === 1 ? "old-token" : "new-signin-token",
        clientToken: "skin-client",
      });
    if (endpoint.endsWith("/validate"))
      return JSON.parse(init.body).accessToken === "new-signin-token"
        ? new Response(null, { status: 204 })
        : jsonResponse({}, 403);
    if (endpoint.endsWith("/refresh")) {
      started.resolve();
      await release.promise;
      return jsonResponse({ accessToken: "stale-rotated-token" });
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  const input = {
    server: "https://skin.example.com",
    username: "player",
    password: "password",
  };
  const account = await service.addYggdrasil(input);
  const pending = assert.rejects(
    service.getForLaunch(account.id),
    /已移除或重新登录/,
  );
  await started.promise;
  const replacement = await service.addYggdrasil(input);
  assert.equal(replacement.id, account.id);
  assert.equal(
    (await service.getForLaunch(account.id)).accessToken,
    "new-signin-token",
  );
  release.resolve();
  await pending;
  assert.equal((await service.list())[0].name, "NewPlayer");
  const stored = JSON.parse(
    await fs.readFile(path.join(dir, "accounts.json"), "utf8"),
  );
  const secret = JSON.parse(
    safeStorage.decryptString(
      Buffer.from(stored[0].encryptedSecrets, "base64"),
    ),
  );
  assert.equal(secret.accessToken, "new-signin-token");
});

test("appearance updates preserve Microsoft credentials rotated while the profile request was pending", async (t) => {
  const started = deferred(),
    release = deferred();
  let appearance = false,
    rotate = false;
  const { service, dir, account } = await microsoftFixture(
    t,
    async (endpoint) => {
      if (appearance && endpoint.endsWith("/minecraft/profile")) {
        appearance = false;
        started.resolve();
        await release.promise;
        return jsonResponse({
          id: "0123456789abcdef0123456789abcdef",
          name: "AppearancePlayer",
          skins: [],
          capes: [],
        });
      }
      if (rotate && endpoint.endsWith("/token"))
        return jsonResponse({
          access_token: "test-microsoft-secret",
          refresh_token: "rotated-refresh-secret",
        });
      if (rotate && endpoint.endsWith("/authentication/login_with_xbox"))
        return jsonResponse({
          access_token: "rotated-minecraft-secret",
          expires_in: 86400,
        });
      if (rotate && endpoint.endsWith("/entitlements/mcstore"))
        return jsonResponse({ items: [{ name: "game_minecraft" }] });
    },
  );
  const previousNow = Date.now;
  let now = previousNow();
  t.after(() => {
    Date.now = previousNow;
    release.resolve();
  });
  Date.now = () => now;
  appearance = true;
  const pending = service.profile(account.id);
  await started.promise;
  now += 2 * 24 * 60 * 60 * 1000;
  rotate = true;
  assert.equal(
    (await service.getForLaunch(account.id)).accessToken,
    "rotated-minecraft-secret",
  );
  release.resolve();
  assert.equal((await pending).name, "AppearancePlayer");
  assert.equal(
    (await service.getForLaunch(account.id)).accessToken,
    "rotated-minecraft-secret",
  );
  const stored = JSON.parse(
    await fs.readFile(path.join(dir, "accounts.json"), "utf8"),
  );
  const secret = JSON.parse(
    safeStorage.decryptString(
      Buffer.from(stored[0].encryptedSecrets, "base64"),
    ),
  );
  assert.equal(secret.accessToken, "rotated-minecraft-secret");
  assert.equal(secret.refreshToken, "rotated-refresh-secret");
});

test("removal during the encrypted profile snapshot rename restores the removed state on disk", async (t) => {
  const { service, dir, events, account } = await microsoftFixture(t);
  const started = deferred(),
    release = deferred();
  const previousRename = fs.rename;
  let held = false;
  fs.rename = async function (from, to) {
    const result = await previousRename.call(this, from, to);
    if (!held && String(to) === path.join(dir, "accounts.json")) {
      held = true;
      started.resolve();
      await release.promise;
    }
    return result;
  };
  t.after(() => {
    fs.rename = previousRename;
    release.resolve();
  });
  const pending = assert.rejects(
    service.profile(account.id),
    /已移除或重新登录/,
  );
  await started.promise;
  const removal = service.remove(account.id);
  await service.list();
  const eventIndex = events.length;
  release.resolve();
  await Promise.all([pending, removal]);
  await assertAccountRemoved(service, dir, events, account.id, eventIndex);
});

test("removing an account during cape ownership lookup prevents the subsequent cape mutation", async (t) => {
  const started = deferred(),
    release = deferred();
  let blockProfile = false;
  const { service, account, calls } = await microsoftFixture(
    t,
    async (endpoint) => {
      if (blockProfile && endpoint.endsWith("/minecraft/profile")) {
        started.resolve();
        await release.promise;
        return jsonResponse({
          id: "0123456789abcdef0123456789abcdef",
          name: "BrowserPlayer",
          capes: [{ id: "owned-cape" }],
        });
      }
    },
  );
  t.after(() => release.resolve());
  blockProfile = true;
  const pending = assert.rejects(
    service.activateCape(account.id, "owned-cape"),
    /已移除或重新登录/,
  );
  await started.promise;
  await service.remove(account.id);
  release.resolve();
  await pending;
  assert(!calls.some((call) => call.endpoint.endsWith("/capes/active")));
});

test("skin changes revalidate expired Microsoft credentials before reading the updated appearance", async (t) => {
  const started = deferred(),
    release = deferred();
  const { service, account, calls } = await microsoftFixture(
    t,
    async (endpoint, init) => {
      if (
        endpoint.endsWith("/minecraft/profile/skins") &&
        init.method === "POST"
      ) {
        assert.deepEqual(JSON.parse(init.body), {
          variant: "slim",
          url: "https://skin.example.com/player.png",
        });
        started.resolve();
        await release.promise;
        return jsonResponse({});
      }
    },
  );
  const previousNow = Date.now;
  let now = previousNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = previousNow;
    release.resolve();
  });
  const pending = service.useSkinUrl(
    account.id,
    "https://skin.example.com/player.png",
    "slim",
  );
  await started.promise;
  now += 2 * 24 * 60 * 60 * 1000;
  release.resolve();
  const profile = await pending;
  assert.equal(profile.editable, true);
  assert.equal(
    profile.skins[0].url,
    "https://textures.minecraft.net/texture/example",
  );
  const refreshes = calls.filter(
    (call) =>
      call.endpoint.endsWith("/token") &&
      new URLSearchParams(call.init.body).get("grant_type") === "refresh_token",
  );
  assert.equal(refreshes.length, 1);
});
