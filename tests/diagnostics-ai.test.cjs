const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const {
  CrashDiagnostics,
  diagnoseText,
  redactDiagnosticText,
  diagnosisSharePayload,
} = require(path.join(compiledRoot, "core/services/crash-diagnostics.js"));
const { AIService, validateAIConfigurationChanges } = require(
  path.join(compiledRoot, "core/services/ai.js"),
);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-diagnosis-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const game = path.join(dir, "game");
  await fs.mkdir(path.join(game, "crash-reports"), { recursive: true });
  await fs.mkdir(path.join(game, "logs"), { recursive: true });
  return { dir, game, diagnostics: new CrashDiagnostics(dir) };
}
function report(text = "java.lang.OutOfMemoryError: Java heap space") {
  return diagnoseText(text, {
    instanceId: "instance-a",
    exitCode: 1,
    terminationReason: "crash",
  });
}
function response(content, status = 200) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content:
              typeof content === "string" ? content : JSON.stringify(content),
          },
        },
      ],
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}
function encryption() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(buffer) {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        buffer.subarray(0, 12),
      );
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([
        decipher.update(buffer.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
const current = {
  memoryMode: "manual",
  memoryMb: 4096,
  javaPath: "",
  jvmArgs: [],
};

test("crash rules distinguish actionable fault classes and unknown exit codes", () => {
  const cases = [
    ["java.lang.OutOfMemoryError: Java heap space", "memory"],
    [
      "UnsupportedClassVersionError: Example compiled by class file version 65.0",
      "java",
    ],
    ["DuplicateModsFoundException: Found duplicate mods", "duplicate-mod"],
    [
      "Mod fancymod requires version 2 of helper which is missing",
      "dependency",
    ],
    [
      "Mixin apply for mod example failed: example.mixins.json:MainMixin",
      "mixin",
    ],
    [
      "GLFW error 65542: WGL: The driver does not appear to support OpenGL",
      "graphics",
    ],
  ];
  for (const [text, category] of cases) {
    const result = report(text);
    assert.equal(result.category, category);
    assert.ok(result.evidence.length);
    assert.ok(result.recommendations.length);
    assert.ok(result.confidence > 0.8);
  }
  const unknown = report("Process exited with code 1");
  assert.equal(unknown.category, "unknown");
  assert.deepEqual(unknown.suspectedMods, []);
  assert.ok(unknown.confidence < 0.5);
});

test("suspected mods require direct error ownership rather than unrelated inventory names", () => {
  const result = diagnoseText(
    "Mixin apply for mod example failed: example.mixins.json:MainMixin\nLoaded friendlymod successfully",
    {
      instanceId: "a",
      mods: [{ id: "example", name: "Example Mod" }, { id: "friendlymod" }],
    },
  );
  assert.equal(result.category, "mixin");
  assert.deepEqual(
    result.suspectedMods.map((mod) => mod.id),
    ["example"],
  );
  assert.ok(result.suspectedMods[0].confidence <= 0.8);
});

test("diagnostic redaction removes credentials, identities, home paths, IPs and chat", () => {
  const text = [
    "accessToken: access-secret refresh_token=refresh-secret Bearer bearer-secret",
    "api_key=provider-secret Password: super-secret",
    "C:\\Users\\PrivateUser\\Game\\latest.log /home/privateuser/game",
    "mail private@example.com 12345678-1234-5678-1234-567812345678",
    "Connecting to mc.private.example:25565 [CHAT] <User> private chat",
    "Setting user: SecretPlayer 192.168.1.55:25565 direct-known-secret",
  ].join("\n");
  const safe = redactDiagnosticText(text, ["direct-known-secret"]);
  for (const secret of [
    "access-secret",
    "refresh-secret",
    "bearer-secret",
    "provider-secret",
    "super-secret",
    "PrivateUser",
    "privateuser",
    "private@example.com",
    "12345678-1234-5678-1234-567812345678",
    "mc.private.example",
    "private chat",
    "SecretPlayer",
    "192.168.1.55",
    "direct-known-secret",
  ])
    assert.equal(safe.includes(secret), false, secret);
});

test("real Minecraft log4j XML format preserves messages, throwables and mod diagnosis evidence", async () => {
  const xml = await fs.readFile(
    path.join(__dirname, "fixtures", "log4j-crash-output.xml"),
    "utf8",
  );
  const safe = redactDiagnosticText(xml);
  assert.equal(safe, xml);
  assert.equal(safe.includes("[CHAT REDACTED]"), false);
  const diagnosis = diagnoseText(xml, {
    instanceId: "xml-instance",
    mods: [{ id: "example", name: "Example Mod" }],
  });
  assert.equal(diagnosis.category, "mixin");
  assert.ok(
    diagnosis.evidence.some((entry) =>
      entry.snippet.includes("example.mixins.json:MainMixin"),
    ),
  );
  assert.deepEqual(
    diagnosis.suspectedMods.map((mod) => mod.id),
    ["example"],
  );
  assert.ok(
    diagnosis.logTail.some((line) => line.includes("<log4j:Throwable>")),
  );
});

test("only explicit CHAT markers redact messages and XML chat keeps its event frame", () => {
  const xml =
    "<log4j:Message><![CDATA[[CHAT] <Steve> private chat text]]></log4j:Message>";
  assert.equal(
    redactDiagnosticText(xml),
    "<log4j:Message><![CDATA[[CHAT REDACTED]]]></log4j:Message>",
  );
  assert.equal(
    redactDiagnosticText(
      "[12:00:00] [Render thread/INFO]: [CHAT] <Steve> private chat text",
    ),
    "[12:00:00] [Render thread/INFO]: [CHAT REDACTED]",
  );
  for (const ordinary of [
    "<log4j:Message>Java failed</log4j:Message>",
    "Loaded List<ModFile> successfully",
    "[CHATTER] Render diagnostics",
    "[CHAT_CONFIG] initialized",
  ])
    assert.equal(redactDiagnosticText(ordinary), ordinary);
});

test("stream capture joins split UTF-8 and tokens, limits lines and never leaks a huge line", async (t) => {
  const f = await fixture(t);
  const emitted = [];
  const session = await f.diagnostics.begin({
    instanceId: "instance-a",
    gameDirectory: f.game,
    secrets: ["super-secret-token"],
    onLine: (line) => emitted.push(line),
  });
  const bytes = Buffer.from("中文 super-secret-token\n", "utf8");
  session.capture("stdout", bytes.subarray(0, 1));
  session.capture("stdout", bytes.subarray(1, 14));
  session.capture("stdout", bytes.subarray(14));
  session.capture("stderr", "z".repeat(40000) + "super-secret-token\n");
  assert.equal(emitted[0], "中文 [REDACTED]");
  assert.equal(emitted[1], "[过长日志行已省略]");
  for (let i = 0; i < 600; i++) session.capture("stdout", `line ${i}\n`);
  session.capture("stderr", "java.lang.OutOfMemoryError: Java heap space");
  const diagnosis = await session.finish({ exitCode: 1 });
  assert.equal(diagnosis.category, "memory");
  assert.equal(diagnosis.logTail.length, 500);
  assert.equal(JSON.stringify(diagnosis).includes("super-secret-token"), false);
  assert.equal(await session.finish({ exitCode: 2 }), diagnosis);
  assert.equal((await f.diagnostics.list()).length, 1);
});

test("normal exit and intentional stop do not produce crash reports", async (t) => {
  const f = await fixture(t);
  for (const [code, stopped] of [
    [0, false],
    [1, true],
    [null, true],
  ]) {
    const session = await f.diagnostics.begin({
      instanceId: "instance-a",
      gameDirectory: f.game,
    });
    session.capture("stderr", "OutOfMemoryError\n");
    if (stopped) session.markStopped();
    assert.equal(await session.finish({ exitCode: code }), undefined);
  }
  assert.deepEqual(await f.diagnostics.list(), []);
});

test("collector excludes stale reports and logs, persists only current-run evidence", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.game, "crash-reports", "old.txt"),
    "OutOfMemoryError",
  );
  await fs.writeFile(
    path.join(f.game, "logs", "latest.log"),
    "OutOfMemoryError",
  );
  const session = await f.diagnostics.begin({
    instanceId: "instance-a",
    gameDirectory: f.game,
  });
  await fs.writeFile(
    path.join(f.game, "crash-reports", "new.txt"),
    "UnsupportedClassVersionError: class file version 65.0",
  );
  const result = await session.finish({ exitCode: 1 });
  assert.equal(result.category, "java");
  assert.deepEqual(result.collectedFiles, ["crash-reports/new.txt"]);
  assert.equal(
    result.logTail.some((line) => line.includes("OutOfMemoryError")),
    false,
  );
  assert.equal(
    (await new CrashDiagnostics(f.dir).get(result.id)).instanceId,
    "instance-a",
  );
  assert.deepEqual(await f.diagnostics.list("other-instance"), []);
});

test("collector refuses junction traversal out of the instance", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.dir, "outside");
  await fs.mkdir(outside);
  await fs.rm(path.join(f.game, "crash-reports"), { recursive: true });
  try {
    await fs.symlink(
      outside,
      path.join(f.game, "crash-reports"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Host does not permit links");
      return;
    }
    throw error;
  }
  const session = await f.diagnostics.begin({
    instanceId: "instance-a",
    gameDirectory: f.game,
  });
  await fs.writeFile(
    path.join(outside, "external.txt"),
    "OutOfMemoryError private external data",
  );
  const result = await session.finish({ exitCode: 1 });
  assert.equal(result.category, "unknown");
  assert.deepEqual(result.collectedFiles, []);
  assert.equal(JSON.stringify(result).includes("private external data"), false);
});

test("explicit report import is bounded, private and instance-scoped", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, "input.txt");
  await fs.writeFile(
    file,
    "OutOfMemoryError: Java heap space accessToken=import-secret",
  );
  const result = await f.diagnostics.importReport({
    instanceId: "second-instance",
    file,
  });
  assert.equal(result.category, "memory");
  assert.equal(result.terminationReason, "imported");
  assert.equal(JSON.stringify(result).includes("import-secret"), false);
  assert.equal((await f.diagnostics.list("second-instance")).length, 1);
  await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(
    f.diagnostics.importReport({ instanceId: "second-instance", file }),
    /2 MiB/,
  );
  await assert.rejects(f.diagnostics.get("..\\outside"), /标识/);
});

test("remote payload omits run identities and absolute local paths and bounds log lines", () => {
  const value = report("OutOfMemoryError\nD:\\PrivateProject\\game\\data.txt");
  value.logTail.push(...Array.from({ length: 200 }, (_, i) => `line ${i}`));
  const payload = diagnosisSharePayload(value);
  assert.equal(payload.logTail.length, 150);
  assert.equal("instanceId" in payload, false);
  assert.equal("runId" in payload, false);
  assert.equal(JSON.stringify(payload).includes("PrivateProject"), false);
});

test("AI disabled and Mock modes require no network and preserve deterministic rule evidence", async (t) => {
  const f = await fixture(t);
  let fetches = 0;
  const ai = new AIService(f.dir, {
    fetch: async () => {
      fetches++;
      throw Error("unexpected network");
    },
  });
  await ai.load();
  const local = report();
  assert.equal((await ai.diagnose(local)).ai.status, "disabled");
  await ai.configureSettings({ enabled: true, provider: "mock" });
  const mock = await ai.diagnose(local);
  assert.equal(mock.ai.status, "enhanced");
  assert.equal(mock.ai.provider, "mock");
  assert.deepEqual(mock.evidence, local.evidence);
  assert.equal(fetches, 0);
});

test("API keys are encrypted separately, never returned, and can be cleared", async (t) => {
  const f = await fixture(t);
  const secretStorage = encryption();
  const ai = new AIService(f.dir, { secretStorage });
  await ai.load();
  const key = "top-secret-provider-key";
  const saved = await ai.configureSettings({ enabled: true, apiKey: key });
  assert.equal(saved.keyPersistence, "encrypted");
  assert.equal(JSON.stringify(saved).includes(key), false);
  for (const file of ["ai-settings.json", "ai-secrets.json"])
    assert.equal(
      (await fs.readFile(path.join(f.dir, file), "utf8")).includes(key),
      false,
    );
  const restarted = new AIService(f.dir, { secretStorage });
  await restarted.load();
  assert.equal(restarted.settings().keyConfigured, true);
  assert.equal(restarted.settings().keyPersistence, "encrypted");
  await restarted.configureSettings({ clearApiKey: true });
  assert.equal(restarted.settings().keyConfigured, false);
  await assert.rejects(fs.access(path.join(f.dir, "ai-secrets.json")));
});

test("no encryption means memory-only credentials; Node fallback preserves existing encrypted secrets", async (t) => {
  const f = await fixture(t);
  const encrypted = new AIService(f.dir, { secretStorage: encryption() });
  await encrypted.configureSettings({ apiKey: "encrypted-existing-key" });
  const before = await fs.readFile(path.join(f.dir, "ai-secrets.json"), "utf8");
  const cli = new AIService(f.dir, { apiKey: "environment-runtime-key" });
  await cli.load();
  await cli.configureSettings({ enabled: true });
  assert.equal(cli.settings().keyPersistence, "memory");
  assert.equal(
    await fs.readFile(path.join(f.dir, "ai-secrets.json"), "utf8"),
    before,
  );
  const locked = new AIService(f.dir);
  await locked.load();
  assert.equal(locked.settings().keyConfigured, false);
  assert.match(locked.settings().warning, /解密/);
  await locked.configureSettings({ apiKey: "new-memory-only-key" });
  assert.equal(locked.settings().keyPersistence, "memory");
  await assert.rejects(fs.access(path.join(f.dir, "ai-secrets.json")));
  assert.equal(
    (await fs.readFile(path.join(f.dir, "ai-settings.json"), "utf8")).includes(
      "new-memory-only-key",
    ),
    false,
  );
});

test("remote diagnosis requires explicit consent, sends sanitized data and cannot replace rules", async (t) => {
  const f = await fixture(t);
  const key = "remote-sensitive-provider-key";
  let calls = 0;
  const ai = new AIService(f.dir, {
    apiKey: key,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, "https://example.com/v1/chat/completions");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      const sent = JSON.stringify(JSON.parse(options.body).messages);
      for (const privateValue of [
        key,
        "private@example.com",
        "PrivateUser",
        "instance-a",
        "session-token",
      ])
        assert.equal(sent.includes(privateValue), false, privateValue);
      return response({
        summary: `内存不足 ${key}`,
        recommendations: ["先减少渲染距离"],
        suspectedMods: [],
      });
    },
  });
  await ai.configureSettings({
    enabled: true,
    provider: "openai-compatible",
    baseUrl: "https://example.com/v1",
  });
  const local = report(
    `OutOfMemoryError\nC:\\Users\\PrivateUser\\Game\nprivate@example.com accessToken=session-token ${key}`,
  );
  await assert.rejects(ai.diagnose(local), /明确授权/);
  assert.equal(calls, 0);
  const result = await ai.diagnose(local, { consent: true });
  assert.equal(result.ai.status, "enhanced");
  assert.equal(result.ai.summary.includes(key), false);
  assert.deepEqual(result.evidence, local.evidence);
  assert.equal(result.source, "rules");
  assert.equal(calls, 1);
});

test("malformed, failed, oversized and fabricated AI results all fall back without private errors", async (t) => {
  const f = await fixture(t);
  for (const remote of [
    async () => response("not-json"),
    async () => new Response("private-provider-error", { status: 429 }),
    async () => new Response("x".repeat(100 * 1024)),
    async () =>
      response({
        summary: "原因",
        recommendations: ["检查模组"],
        suspectedMods: [
          {
            id: "invented-mod",
            name: "Invented",
            reason: "guess",
            confidence: 1,
          },
        ],
      }),
    async () => {
      throw Error("private-provider-error leaked-key");
    },
  ]) {
    const ai = new AIService(f.dir, { apiKey: "leaked-key", fetch: remote });
    await ai.configureSettings({
      enabled: true,
      provider: "openai-compatible",
    });
    const local = report();
    const result = await ai.diagnose(local, { consent: true });
    assert.equal(result.ai.status, "fallback");
    assert.deepEqual(result.evidence, local.evidence);
    assert.equal(
      JSON.stringify(result).includes("private-provider-error"),
      false,
    );
    assert.equal(JSON.stringify(result).includes("leaked-key"), false);
  }
});

test("remote AI timeouts are bounded and retain rule diagnosis", async (t) => {
  const f = await fixture(t);
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const ai = new AIService(f.dir);
  await ai.configureSettings({
    enabled: true,
    provider: "openai-compatible",
    timeoutMs: 1000,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  });
  const started = Date.now();
  const result = await ai.diagnose(report(), { consent: true });
  assert.equal(result.ai.status, "fallback");
  assert.ok(Date.now() - started < 5000);
});

test("declared oversized AI bodies are cancelled without consuming an unbounded stream", async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  const ai = new AIService(f.dir, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Length": String(100 * 1024) } },
      ),
  });
  await ai.configureSettings({ enabled: true, provider: "openai-compatible" });
  const result = await ai.diagnose(report(), { consent: true });
  assert.equal(result.ai.status, "fallback");
  assert.equal(cancelled, true);
  await assert.rejects(
    ai.configureSettings({ clearApiKey: "false" }),
    /标志无效/,
  );
});

test("AI endpoint validation rejects remote HTTP, URL credentials and query keys", async (t) => {
  const f = await fixture(t);
  const ai = new AIService(f.dir);
  for (const baseUrl of [
    "http://example.com/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?api_key=secret",
    "file:///tmp/fake",
  ])
    await assert.rejects(ai.configureSettings({ baseUrl }), /HTTPS|地址/);
  await ai.configureSettings({ baseUrl: "http://127.0.0.1:8080/v1" });
  assert.equal(ai.settings().baseUrl, "http://127.0.0.1:8080/v1");
});

test("configuration suggestions only preview validated differences and require explicit later apply", async (t) => {
  const f = await fixture(t);
  const ai = new AIService(f.dir);
  await ai.configureSettings({ enabled: true, provider: "mock" });
  const before = await fs.readFile(
    path.join(f.dir, "ai-settings.json"),
    "utf8",
  );
  const settingsBefore = structuredClone(current);
  const suggestion = await ai.configure("低内存电脑，请减少内存占用", current, {
    totalMemoryMb: 4096,
  });
  assert.equal(suggestion.requiresApply, true);
  assert.equal(suggestion.source, "mock");
  assert.equal(suggestion.changes.memoryMb, 1024);
  assert.ok(suggestion.diff.some((diff) => diff.key === "memoryMb"));
  assert.deepEqual(current, settingsBefore);
  assert.equal(
    await fs.readFile(path.join(f.dir, "ai-settings.json"), "utf8"),
    before,
  );
  suggestion.changes.memoryMb = 999999;
  assert.equal(ai.getSuggestion(suggestion.id).changes.memoryMb, 1024);
});

test("remote JVM recommendations accept whitelist only and reject arbitrary Java paths and oversized memory", async (t) => {
  const f = await fixture(t);
  const accepted = {
    memoryMode: "manual",
    memoryMb: 2048,
    javaPath: "",
    jvmArgs: [
      "-XX:+UseG1GC",
      "-XX:MaxGCPauseMillis=200",
      "-XX:+ParallelRefProcEnabled",
    ],
  };
  assert.deepEqual(validateAIConfigurationChanges(accepted, 8192), accepted);
  for (const changes of [
    { javaPath: "C:\\evil.exe" },
    { jvmArgs: ["-javaagent:evil.jar"] },
    { jvmArgs: ["-Dhttp.proxyHost=evil"] },
    { jvmArgs: ["-cp", "evil.jar"] },
    { memoryMb: 99999 },
    { memoryMb: 6000 },
    { memoryMode: "broken" },
    { accessToken: "secret" },
  ])
    assert.throws(() => validateAIConfigurationChanges(changes, 4096));
  const ai = new AIService(f.dir, {
    fetch: async () =>
      response({
        summary: "运行任意程序",
        changes: { javaPath: "C:\\evil.exe", jvmArgs: ["-javaagent:evil.jar"] },
      }),
  });
  await ai.configureSettings({ enabled: true, provider: "openai-compatible" });
  const suggestion = await ai.configure("优化启动", current, {
    totalMemoryMb: 8192,
    consent: true,
  });
  assert.equal(suggestion.source, "rules");
  assert.deepEqual(suggestion.changes, { memoryMode: "auto", javaPath: "" });
  assert.ok(suggestion.warnings.length);
});
