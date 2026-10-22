const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  DownloadManager,
  controlDownload,
  setTaskDownloadSource,
  downloadUrls,
} = require("@ldfcl/core/services/downloads");
const hash = (body) => createHash("sha1").update(body).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("fixture timed out");
    await delay(5);
  }
}
async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-resume-"));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    url: `http://127.0.0.1:${server.address().port}/artifact`,
  };
}
async function seed(item, body, etag = '"same"') {
  await fs.writeFile(`${item.path}.part`, body);
  await fs.writeFile(
    `${item.path}.part.meta`,
    JSON.stringify({
      identity: JSON.stringify([
        item.url,
        item.size,
        item.sha1,
        item.sha256,
        item.sha512,
      ]),
      etag,
    }),
  );
}
test("failed network transfers persist verified identity and a new process resumes with Range/If-Range", async (t) => {
  const body = Buffer.alloc(100000, 7),
    ranges = [];
  let attempts = 0;
  const { directory, url } = await fixture(t, (req, res) => {
    attempts++;
    const offset = Number(
      /bytes=(\d+)-/.exec(req.headers.range || "")?.[1] || 0,
    );
    ranges.push({ offset, validator: req.headers["if-range"] });
    res.writeHead(offset ? 206 : 200, {
      "Content-Length": body.length - offset,
      ETag: '"same"',
      ...(offset
        ? {
            "Content-Range": `bytes ${offset}-${body.length - 1}/${body.length}`,
          }
        : {}),
    });
    if (attempts <= 3) {
      res.write(body.subarray(offset, offset + 4096));
      setTimeout(() => res.destroy(), 20);
    } else res.end(body.subarray(offset));
  });
  const item = {
    url,
    path: path.join(directory, "game.jar"),
    size: body.length,
    sha1: hash(body),
  };
  await assert.rejects(new DownloadManager(directory).downloadVerified(item));
  const retained = (await fs.stat(`${item.path}.part`)).size;
  assert(retained > 0 && retained < body.length);
  await promisify(execFile)(
    process.execPath,
    [
      "-e",
      'const {DownloadManager}=require("@ldfcl/core/services/downloads"); const item=JSON.parse(process.argv[1]); new DownloadManager(process.argv[2]).downloadVerified(item).catch(e=>{console.error(e.message);process.exitCode=1})',
      JSON.stringify(item),
      directory,
    ],
    { cwd: path.resolve(__dirname, ".."), timeout: 20000 },
  );
  assert.equal(ranges.at(-1).offset, retained);
  assert.equal(ranges.at(-1).validator, '"same"');
  assert.deepEqual(await fs.readFile(item.path), body);
  await assert.rejects(fs.access(`${item.path}.part.meta`));
});
test("pause stops transferred bytes, resume completes, task source can change while paused", async (t) => {
  const body = Buffer.alloc(128000, 3),
    ranges = [],
    events = [];
  const { directory, url } = await fixture(t, (req, res) => {
    let offset = Number(/bytes=(\d+)-/.exec(req.headers.range || "")?.[1] || 0);
    ranges.push(offset);
    res.writeHead(offset ? 206 : 200, {
      "Content-Length": body.length - offset,
      ETag: '"same"',
      ...(offset
        ? {
            "Content-Range": `bytes ${offset}-${body.length - 1}/${body.length}`,
          }
        : {}),
    });
    const timer = setInterval(() => {
      const next = Math.min(offset + 4096, body.length);
      res.write(body.subarray(offset, next));
      offset = next;
      if (offset === body.length) {
        clearInterval(timer);
        res.end();
      }
    }, 10);
    res.on("close", () => clearInterval(timer));
  });
  const manager = new DownloadManager(directory, ({ task }) =>
    events.push(task),
  );
  const item = {
    url,
    path: path.join(directory, "pause.jar"),
    size: body.length,
    sha1: hash(body),
  };
  const operation = manager.downloadVerified(item);
  await until(async () => {
    try {
      return (await fs.stat(`${item.path}.part`)).size > 0;
    } catch {
      return false;
    }
  });
  controlDownload(events[0].id, "pause");
  await until(() => events.some((event) => event.status === "paused"));
  await delay(30);
  const first = (await fs.stat(`${item.path}.part`)).size;
  await delay(50);
  assert.equal((await fs.stat(`${item.path}.part`)).size, first);
  const id = events[0].id;
  setTaskDownloadSource(id, "bmclapi");
  assert.equal(events.at(-1).source, "bmclapi");
  controlDownload(id, "resume");
  await operation;
  assert(ranges.some((offset) => offset > 0));
  assert.equal(events.at(-1).status, "completed");
  assert.deepEqual(await fs.readFile(item.path), body);
  assert.throws(() => controlDownload(id, "resume"), /结束/);
});
test("cancelling an aggregate stops active transfers and removes their partials", async (t) => {
  const events = [];
  const { directory, url } = await fixture(t, (_, res) => {
    res.writeHead(200, { "Content-Length": 50000, ETag: '"same"' });
    res.write(Buffer.alloc(3000));
    const timer = setInterval(() => res.write(Buffer.alloc(1000)), 20);
    res.on("close", () => clearInterval(timer));
  });
  const manager = new DownloadManager(
    directory,
    ({ task }) => events.push(task),
    2,
  );
  const operation = manager.downloadMany(
    ["a", "b"].map((name) => ({
      url,
      path: path.join(directory, name),
      size: 50000,
    })),
  );
  const rejected = assert.rejects(operation, /取消/);
  await until(() => events.some((event) => event.progress > 0));
  controlDownload(events[0].id, "cancel");
  await rejected;
  assert.equal(events.at(-1).status, "cancelled");
  assert.deepEqual(await fs.readdir(directory), []);
});
test("200 after If-Range change truncates the old partial instead of appending", async (t) => {
  const body = Buffer.from("new resource body"),
    seen = [];
  const { directory, url } = await fixture(t, (req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { ETag: '"new"' });
    res.end(body);
  });
  const item = {
    url,
    path: path.join(directory, "changed"),
    size: body.length,
    sha1: hash(body),
  };
  await seed(item, Buffer.from("old"), '"old"');
  await new DownloadManager(directory).downloadVerified(item);
  assert.equal(seen[0].range, "bytes=3-");
  assert.equal(seen[0]["if-range"], '"old"');
  assert.deepEqual(await fs.readFile(item.path), body);
});
test("416 publishes a complete partial only with matching validator and correct total", async (t) => {
  const body = Buffer.from("complete"),
    seen = [];
  const { directory, url } = await fixture(t, (req, res) => {
    seen.push(req.headers.range);
    res.writeHead(416, {
      "Content-Range": `bytes */${body.length}`,
      ETag: '"same"',
    });
    res.end();
  });
  const item = { url, path: path.join(directory, "complete") };
  await seed(item, body);
  await new DownloadManager(directory).downloadVerified(item);
  assert.deepEqual(seen, [`bytes=${body.length}-`]);
  assert.deepEqual(await fs.readFile(item.path), body);
});
test("corrupt complete partial and 416 trigger a clean verified restart", async (t) => {
  const body = Buffer.from("correct!"),
    requests = [];
  const { directory, url } = await fixture(t, (req, res) => {
    requests.push(req.headers.range);
    if (req.headers.range) {
      res.writeHead(416, {
        "Content-Range": `bytes */${body.length}`,
        ETag: '"same"',
      });
      res.end();
    } else res.end(body);
  });
  const item = {
    url,
    path: path.join(directory, "corrupt"),
    size: body.length,
    sha1: hash(body),
  };
  await seed(item, Buffer.from("damaged!"));
  await new DownloadManager(directory).downloadVerified(item);
  assert.equal(requests.length, 2);
  assert.equal(requests[1], undefined);
  assert.deepEqual(await fs.readFile(item.path), body);
});
test("mirror mapping is restricted to known public artifact hosts and preserves official fallback", () => {
  assert.deepEqual(
    downloadUrls("https://resources.download.minecraft.net/ab/hash", "bmclapi"),
    [
      "https://bmclapi2.bangbang93.com/assets/ab/hash",
      "https://resources.download.minecraft.net/ab/hash",
    ],
  );
  for (const url of [
    "https://login.live.com/token",
    "https://api.minecraftservices.com/authentication/login_with_xbox",
    "https://evil.example/game.jar",
    "http://libraries.minecraft.net/a",
    "https://user:password@libraries.minecraft.net/a",
  ])
    assert.deepEqual(downloadUrls(url, "bmclapi"), [url]);
});
test("mirror HTTP 403 falls back to the official artifact without inheriting an aborted controller", async (t) => {
  const body = Buffer.from("official fallback content");
  const { directory, url } = await fixture(t, (_, res) => res.end(body));
  const realFetch = global.fetch,
    called = [];
  global.fetch = async (target, init) => {
    called.push(String(target));
    if (String(target).startsWith("https://bmclapi2.bangbang93.com/"))
      return new Response("denied", { status: 403 });
    assert.equal(init.signal.aborted, false);
    return realFetch(url, init);
  };
  const item = {
    url: "https://resources.download.minecraft.net/ab/hash",
    source: "bmclapi",
    path: path.join(directory, "fallback"),
    sha1: hash(body),
    size: body.length,
  };
  try {
    await new DownloadManager(directory).downloadVerified(item);
    assert.deepEqual(called, [
      "https://bmclapi2.bangbang93.com/assets/ab/hash",
      item.url,
    ]);
    assert.deepEqual(await fs.readFile(item.path), body);
  } finally {
    global.fetch = realFetch;
  }
});
test("cancelling a task waiting for the global slot removes it without sending an HTTP request", async (t) => {
  const hits = [],
    events = [];
  const { directory, url } = await fixture(t, (req, res) => {
    hits.push(req.url);
    setTimeout(() => res.end("data"), 100);
  });
  const first = new DownloadManager(directory, () => {}, 1),
    second = new DownloadManager(directory, ({ task }) => events.push(task), 1);
  const active = first.download(url + "/first", path.join(directory, "first"));
  await until(() => hits.length > 0);
  const queued = second.download(
    url + "/queued",
    path.join(directory, "queued"),
  );
  const rejected = assert.rejects(queued, /取消/);
  controlDownload(events[0].id, "cancel");
  await rejected;
  await active;
  assert.deepEqual(hits, ["/artifact/first"]);
  assert.equal(events.at(-1).status, "cancelled");
});
test("changed ETag on a 206 response discards the partial and retries from zero", async (t) => {
  const body = Buffer.from("current complete artifact"),
    requests = [];
  const { directory, url } = await fixture(t, (req, res) => {
    requests.push(req.headers.range);
    if (req.headers.range) {
      res.writeHead(206, {
        "Content-Range": `bytes 3-${body.length - 1}/${body.length}`,
        "Content-Length": body.length - 3,
        ETag: '"new"',
      });
      res.end(body.subarray(3));
    } else {
      res.writeHead(200, { ETag: '"new"' });
      res.end(body);
    }
  });
  const item = {
    url,
    path: path.join(directory, "etag"),
    sha1: hash(body),
    size: body.length,
  };
  await seed(item, Buffer.from("old"), '"old"');
  await new DownloadManager(directory).downloadVerified(item);
  assert.deepEqual(requests, ["bytes=3-", undefined]);
  assert.deepEqual(await fs.readFile(item.path), body);
});
test("content reissued into a new transaction resumes its stable verified artifact before copying into staging", async (t) => {
  const { ContentService } = require("@ldfcl/core/services/content");
  const body = Buffer.alloc(64000, 9),
    ranges = [];
  let calls = 0;
  const { directory, url } = await fixture(t, (req, res) => {
    calls++;
    const offset = Number(
      /bytes=(\d+)-/.exec(req.headers.range || "")?.[1] || 0,
    );
    ranges.push(offset);
    res.writeHead(offset ? 206 : 200, {
      ETag: '"same"',
      "Content-Length": body.length - offset,
      ...(offset
        ? {
            "Content-Range": `bytes ${offset}-${body.length - 1}/${body.length}`,
          }
        : {}),
    });
    if (calls <= 3) {
      res.write(body.subarray(offset, offset + 4096));
      setTimeout(() => res.destroy(), 20);
    } else res.end(body.subarray(offset));
  });
  const realFetch = global.fetch;
  const remote = "https://cdn.modrinth.com/data/fixture/version/fixture.jar";
  global.fetch = async (target, init) => {
    assert.equal(String(target), remote);
    const response = await realFetch(url, init);
    Object.defineProperty(response, "url", { value: remote });
    return response;
  };
  const firstStage = path.join(
      directory,
      "cache",
      "content",
      "first-transaction.jar",
    ),
    secondStage = path.join(
      directory,
      "cache",
      "content",
      "second-transaction.jar",
    );
  try {
    const first = new ContentService(
      directory,
      () => {},
      () => 2,
    );
    await assert.rejects(
      first.download(remote, firstStage, { sha1: hash(body) }, body.length),
    );
    const artifactDir = path.join(directory, "cache", "content-artifacts");
    const retainedName = (await fs.readdir(artifactDir)).find((name) =>
      name.endsWith(".part"),
    );
    assert(retainedName);
    const retained = (await fs.stat(path.join(artifactDir, retainedName))).size;
    await assert.rejects(fs.access(firstStage));
    await new ContentService(
      directory,
      () => {},
      () => 2,
    ).download(remote, secondStage, { sha1: hash(body) }, body.length);
    assert.equal(ranges.at(-1), retained);
    assert.deepEqual(await fs.readFile(secondStage), body);
    assert.equal(
      (await fs.readdir(artifactDir)).filter(
        (name) => !name.endsWith(".part.meta") && !name.endsWith(".part"),
      ).length,
      1,
    );
  } finally {
    global.fetch = realFetch;
  }
});
test("completed bodies are not aborted and unused mirror bodies are cancelled only once", async (t) => {
  const body = Buffer.from("clean response lifecycle");
  const { directory, url } = await fixture(t, (_, res) => res.end(body));
  const realFetch = global.fetch,
    signals = [];
  let cancelled = 0;
  global.fetch = async (target, init) => {
    signals.push(init.signal);
    if (String(target).includes("bmclapi2.bangbang93.com"))
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: 403 },
      );
    return realFetch(url, init);
  };
  try {
    await new DownloadManager(directory).downloadVerified({
      url: "https://resources.download.minecraft.net/ab/lifecycle",
      source: "bmclapi",
      path: path.join(directory, "lifecycle"),
      size: body.length,
      sha1: hash(body),
    });
    assert.equal(cancelled, 1);
    assert.equal(signals.length, 2);
    assert(
      signals.every((signal) => !signal.aborted),
      "completed or explicitly discarded response streams must not also receive a synthetic abort",
    );
    assert.deepEqual(
      await fs.readFile(path.join(directory, "lifecycle")),
      body,
    );
  } finally {
    global.fetch = realFetch;
  }
});
