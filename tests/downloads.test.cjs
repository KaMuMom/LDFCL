const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { createHash } = require("node:crypto");
const {
  DownloadManager,
  requestJson,
} = require("@ldfcl/core/services/downloads");
const {
  taskProgressPercent,
} = require("../dist-electron/shared/task-progress.js");
const digest = (algorithm, value) =>
  createHash(algorithm).update(value).digest("hex");
async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-queue-"));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, url: `http://127.0.0.1:${server.address().port}` };
}
test("independent managers and batches share one network concurrency budget", async (t) => {
  let active = 0,
    peak = 0;
  const { directory, url } = await fixture(t, (_, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.end("data");
    }, 25);
  });
  const a = new DownloadManager(directory, () => {}, 2);
  const b = new DownloadManager(directory, () => {}, 2);
  const items = (prefix) =>
    Array.from({ length: 5 }, (_, i) => ({
      url,
      path: path.join(directory, `${prefix}${i}`),
    }));
  await Promise.all([
    a.downloadMany(items("a")),
    b.downloadMany(items("b")),
    b.download(url, path.join(directory, "single")),
  ]);
  assert.equal(peak, 2);
});
test("concurrent requests for the same destination revalidate and reuse the published file", async (t) => {
  let count = 0;
  const data = Buffer.from("one verified artifact");
  const { directory, url } = await fixture(t, (_, res) => {
    count++;
    setTimeout(() => res.end(data), 30);
  });
  const a = new DownloadManager(directory, () => {}, 4);
  const b = new DownloadManager(directory, () => {}, 4);
  const item = {
    url,
    path: path.join(directory, "same.jar"),
    sha1: digest("sha1", data),
    size: data.length,
  };
  await Promise.all([
    a.downloadVerified(item),
    b.downloadVerified(item),
    a.downloadMany([item]),
  ]);
  assert.equal(count, 1);
  assert.deepEqual(await fs.readFile(item.path), data);
});
test("cache validates expected size and every advertised hash", async (t) => {
  const data = Buffer.from("correct content");
  let count = 0;
  const { directory, url } = await fixture(t, (_, res) => {
    count++;
    res.end(data);
  });
  const manager = new DownloadManager(directory);
  const item = {
    url,
    path: path.join(directory, "hash.jar"),
    size: data.length,
    sha1: digest("sha1", data),
    sha512: digest("sha512", data),
  };
  await fs.writeFile(item.path, Buffer.from("wrong"));
  await manager.downloadVerified(item);
  await manager.downloadVerified(item);
  assert.equal(count, 1);
  await assert.rejects(
    manager.downloadVerified({ ...item, sha512: "0".repeat(128) }),
    /校验/,
  );
  assert.equal(count, 4, "matching SHA1 must not hide a failing SHA512");
  assert.deepEqual(
    await fs.readFile(item.path),
    data,
    "failed replacement retains prior destination",
  );
  assert.deepEqual(
    (await fs.readdir(directory)).filter((f) => f.endsWith(".part")),
    [],
  );
});
test("404 responses fail once and publish a failed task; destination locks release after errors", async (t) => {
  let count = 0;
  const { directory, url } = await fixture(t, (req, res) => {
    count++;
    res.statusCode = req.url === "/missing" ? 404 : 200;
    res.end("data");
  });
  const events = [];
  const manager = new DownloadManager(directory, (e) => events.push(e.task));
  const destination = path.join(directory, "file.jar");
  await assert.rejects(
    manager.download(
      `${url}/missing`,
      destination,
      undefined,
      undefined,
      "fixture",
    ),
    /404/,
  );
  assert.equal(count, 1);
  assert.equal(events.at(-1).status, "failed");
  await manager.download(`${url}/ok`, destination);
  assert.equal(await fs.readFile(destination, "utf8"), "data");
  await assert.rejects(requestJson(`${url}/missing`), /404/);
  assert.equal(count, 3);
});
test("size caps apply to chunked bodies and HTTPS constraints reject before transfer", async (t) => {
  let count = 0;
  const { directory, url } = await fixture(t, (_, res) => {
    count++;
    res.write("1234");
    res.end("5678");
  });
  const manager = new DownloadManager(directory);
  const item = { url, path: path.join(directory, "cap.jar"), maxBytes: 5 };
  await assert.rejects(manager.downloadVerified(item), /大小/);
  assert.equal(count, 1);
  await assert.rejects(
    manager.downloadVerified({ ...item, requireHttps: true }),
    /HTTP/,
  );
  assert.equal(count, 1);
  assert.deepEqual(await fs.readdir(directory), []);
});
test("batch progress includes partial bytes while validation stays below completion", async (t) => {
  let finishBody;
  const { directory, url } = await fixture(t, (_, res) => {
    res.writeHead(200, { "Content-Length": 8 });
    res.flushHeaders();
    const timer = setTimeout(() => res.end("5678"), 2000);
    finishBody = () => { clearTimeout(timer); res.end("5678"); };
    res.write("1234");
  });
  const events = [];
  const manager = new DownloadManager(directory, (e) => { events.push(e.task); if (e.task.status === "running" && e.task.progress > 0 && e.task.progress < 0.99) finishBody?.(); });
  await manager.downloadMany([
    { url, path: path.join(directory, "partial"), size: 8 },
  ]);
  assert(
    events.some(
      (e) => e.status === "running" && e.progress > 0 && e.progress < 0.99,
    ),
  );
  assert(
    events.filter((e) => e.status !== "completed").every((e) => e.progress < 1),
  );
  assert.equal(events.at(-1).status, "completed");
  assert.equal(events.at(-1).progress, 1);
});
test("progress displays 100 only for completed tasks and handles non-finite values", () => {
  assert.equal(taskProgressPercent({ status: "running", progress: 99.99 }), 99);
  assert.equal(taskProgressPercent({ status: "error", progress: 100 }), 99);
  assert.equal(taskProgressPercent({ status: "running", progress: NaN }), 0);
  assert.equal(taskProgressPercent({ status: "completed", progress: 0 }), 100);
});

test("batch deduplication rejects conflicting constraints before touching any destination", async (t) => {
  let count = 0;
  const { directory, url } = await fixture(t, (_, res) => {
    count++;
    res.end("BBB");
  });
  const events = [];
  const manager = new DownloadManager(directory, (event) =>
    events.push(event.task),
  );
  const destination = path.join(directory, "conflict.jar");
  await fs.writeFile(destination, "existing");
  await assert.rejects(
    manager.downloadMany([
      { url, path: destination, sha1: digest("sha1", "AAA") },
      { url, path: destination, sha1: digest("sha1", "BBB") },
    ]),
    /冲突/,
  );
  await assert.rejects(
    manager.downloadMany([
      { url, path: destination, size: 3 },
      { url, path: destination, size: 4 },
    ]),
    /冲突/,
  );
  assert.equal(count, 0);
  assert.equal(await fs.readFile(destination, "utf8"), "existing");
  assert(events.every((event) => event.status === "failed"));
});

test("compatible batch duplicates merge optional verification constraints", async (t) => {
  let count = 0;
  const data = Buffer.from("verified merged hashes");
  const { directory, url } = await fixture(t, (_, res) => {
    count++;
    res.end(data);
  });
  const manager = new DownloadManager(directory);
  const destination = path.join(directory, "merged.jar");
  await manager.downloadMany([
    { url, path: destination, sha1: digest("sha1", data), maxBytes: 50 },
    {
      url,
      path: destination,
      sha512: digest("sha512", data),
      size: data.length,
      maxBytes: 100,
    },
  ]);
  assert.equal(count, 1);
  await assert.rejects(
    manager.downloadMany([
      { url, path: destination, sha1: "0".repeat(40) },
      { url, path: destination, sha512: digest("sha512", data) },
    ]),
    /校验/,
  );
  assert.equal(count, 4, "optional SHA1 must survive duplicate merging");
  assert.deepEqual(await fs.readFile(destination), data);
});
