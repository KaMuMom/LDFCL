const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const AdmZip = require("adm-zip");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const { rulesAllow, tokenizeArguments, expandArguments, mavenPath } = require(
  path.join(compiledRoot, "core/services/game.js"),
);
const { JavaManager, javaMajor, automaticMemoryMb, safeExtractZip } = require(
  path.join(compiledRoot, "core/services/java.js"),
);
const { DownloadManager, fileHash } = require(
  path.join(compiledRoot, "core/services/downloads.js"),
);

test("Mojang OS rules preserve ordering and distinguish x86 from x64", () => {
  const rules = [
    { action: "allow", os: { name: "windows" } },
    { action: "disallow", os: { arch: "x86" } },
  ];
  assert.equal(rulesAllow(rules, {}, "win32", "x64"), true);
  assert.equal(rulesAllow(rules, {}, "win32", "ia32"), false);
  assert.equal(rulesAllow(rules, {}, "linux", "x64"), false);
  assert.equal(
    rulesAllow(
      [{ action: "allow", os: { arch: "amd64" } }],
      {},
      "win32",
      "x64",
    ),
    true,
  );
  assert.equal(
    rulesAllow(
      [{ action: "allow", os: { name: "windows", version: "^10\\." } }],
      {},
      "win32",
      "x64",
      "10.0.26200",
    ),
    true,
  );
});

test("feature-gated arguments do not enable demo or quick play by default", () => {
  const input = [
    "--username",
    "${auth_player_name}",
    {
      rules: [{ action: "allow", features: { is_demo_user: true } }],
      value: "--demo",
    },
    {
      rules: [{ action: "allow", features: { has_custom_resolution: true } }],
      value: ["--width", "${width}"],
    },
  ];
  assert.deepEqual(
    expandArguments(input, { auth_player_name: "Alex", width: "1920" }),
    ["--username", "Alex"],
  );
  assert.deepEqual(
    expandArguments(
      input,
      { auth_player_name: "Alex", width: "1920" },
      { has_custom_resolution: true },
    ),
    ["--username", "Alex", "--width", "1920"],
  );
});

test("legacy arguments retain quoted paths and Maven native classifiers", () => {
  assert.deepEqual(
    tokenizeArguments(
      '--gameDir "C:\\Games Folder\\Minecraft" --username Alex',
    ),
    ["--gameDir", "C:\\Games Folder\\Minecraft", "--username", "Alex"],
  );
  assert.equal(
    mavenPath("org.lwjgl:lwjgl:3.3.3:natives-windows"),
    "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar",
  );
  assert.throws(() => mavenPath("net.bad:../../evil:1"), /Maven/);
});

test("Java version parsing supports Java 8, current Java and early access", () => {
  assert.equal(javaMajor('java version "1.8.0_503"'), 8);
  assert.equal(javaMajor('openjdk version "17.0.12" 2024-07-16'), 17);
  assert.equal(javaMajor("openjdk 25-ea 2025-09-16"), 25);
  assert.equal(javaMajor("not a Java executable"), null);
});

test("automatic Java selection avoids a PATH shim when a concrete executable exists", async () => {
  const concrete = path.join(os.tmpdir(), "jdk-21", "bin", "java.exe");
  const manager = new JavaManager(os.tmpdir());
  manager.discover = async () => [
    { path: "java", major: 21, version: "21" },
    { path: concrete, major: 21, version: "21" },
  ];
  assert.equal(await manager.ensure(21), concrete);
});

test("automatic memory allocation preserves system headroom and never exceeds 8 GiB", () => {
  const mb = 1048576;
  assert.equal(automaticMemoryMb(32 * 1024 * mb, 24 * 1024 * mb), 8192);
  assert.ok(automaticMemoryMb(4096 * mb, 1800 * mb) <= 768);
  assert.equal(automaticMemoryMb(2048 * mb, 256 * mb), 512);
});

test("ZIP extraction validates traversal and absolute paths before writing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-zip-test-"));
  try {
    const zip = new AdmZip();
    zip.addFile("bin/readme.txt", Buffer.from("safe"));
    safeExtractZip(zip, directory);
    assert.equal(
      await fs.readFile(path.join(directory, "bin/readme.txt"), "utf8"),
      "safe",
    );
    const badZip = {
      getEntries: () => [
        {
          entryName: "../outside.txt",
          isDirectory: false,
          getData: () => Buffer.from("bad"),
        },
      ],
    };
    assert.throws(() => safeExtractZip(badZip, directory), /不安全路径/);
    const absolute = {
      getEntries: () => [
        {
          entryName: "C:/outside.txt",
          isDirectory: false,
          getData: () => Buffer.from("bad"),
        },
      ],
    };
    assert.throws(() => safeExtractZip(absolute, directory), /不安全路径/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("downloader retries corrupt data, checks cache integrity and writes atomically", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ldfcl-download-test-"),
  );
  const body = Buffer.from("LDFCL fixture with expected digest");
  const sha1 = createHash("sha1").update(body).digest("hex");
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    const payload = requests === 1 ? Buffer.alloc(body.length, "x") : body;
    response.writeHead(200, { "Content-Length": payload.length });
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const events = [];
    const downloads = new DownloadManager(
      directory,
      (event) => events.push(event),
      2,
    );
    const file = path.join(directory, "cache", "fixture.jar");
    const url = `http://127.0.0.1:${server.address().port}/artifact`;
    await downloads.download(url, file, sha1, body.length, "校验测试");
    assert.equal(requests, 2);
    assert.equal(await fileHash(file), sha1);
    assert.ok(events.some((event) => event.task.status === "completed"));
    await downloads.download(url, file, sha1, body.length);
    assert.equal(requests, 2, "verified cache should not use network");
    await fs.writeFile(file, Buffer.alloc(body.length, "y"));
    await downloads.download(url, file, sha1, body.length);
    assert.equal(requests, 3, "corrupt cache must be repaired");
    assert.deepEqual(
      (await fs.readdir(path.dirname(file))).filter((name) =>
        name.endsWith(".part"),
      ),
      [],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("multi-file downloads respect the concurrency limit and deduplicate paths", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ldfcl-pool-test-"),
  );
  let active = 0,
    peak = 0,
    count = 0;
  const server = http.createServer((request, response) => {
    count++;
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      response.writeHead(200, { "Content-Length": 4 });
      response.end("test");
    }, 20);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const downloads = new DownloadManager(directory, () => {}, 3);
    const items = Array.from({ length: 10 }, (_, index) => ({
      url: `http://127.0.0.1:${server.address().port}/${index}`,
      path: path.join(directory, `${index}.jar`),
    }));
    await downloads.downloadMany([...items, items[0]], "并发测试");
    assert.equal(count, 10);
    assert.ok(peak > 1 && peak <= 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
