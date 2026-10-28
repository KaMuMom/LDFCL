const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const {
  DownloadManager,
  DownloadCancelledError,
  controlDownload,
  setTaskDownloadSource,
  getDownloadTaskFiles,
} = require("@ldfcl/core/services/downloads");

test("scoped metadata and loader managers inherit plan controls without mutating their parent", async (t) => {
  let requests = 0;
  const { directory, url } = await fixture(t, (_, response) => {
    requests++;
    response.end("data");
  });
  const events = [];
  const manager = new DownloadManager(
    directory,
    (event) => events.push(event.task),
    2,
  );
  const plan = manager.createPlan({
    title: "安装 Fabric",
    context: {
      resourceName: "Minecraft",
      targetInstanceId: "fixture",
      targetInstanceName: "隔离实例",
    },
    stages: [
      { id: "metadata", title: "元数据" },
      { id: "loader", title: "加载器" },
    ],
  });
  const metadata = manager.scoped(plan.context("metadata"));
  const loader = metadata.scoped(plan.context("loader"));
  plan.startStage("metadata");
  await metadata.download(
    url,
    path.join(directory, "version.json"),
    undefined,
    4,
    "版本元数据",
  );
  plan.completeStage("metadata");
  plan.startStage("loader");
  controlDownload(plan.id, "pause");
  setTaskDownloadSource(plan.id, "bmclapi");
  const pending = loader.downloadMany(
    [{ url, path: path.join(directory, "fabric.jar"), size: 4 }],
    "加载器文件",
    { resourceName: "Fabric Loader" },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    requests,
    1,
    "a metadata/loader helper without explicit context must still obey its plan pause",
  );
  controlDownload(plan.id, "resume");
  await pending;
  const child = events.find(
    (task) => task.title === "加载器文件" && task.status === "completed",
  );
  assert.equal(child.download.planId, plan.id);
  assert.equal(child.download.stageId, "loader");
  assert.equal(child.download.resourceName, "Fabric Loader");
  assert.equal(child.download.targetInstanceName, "隔离实例");
  assert.equal(child.source, "bmclapi");
  plan.completeStage("loader");
  plan.complete();
  await manager.download(url, path.join(directory, "standalone.json"));
  assert.equal(
    events.at(-1).download.planId,
    undefined,
    "the original manager does not retain the scoped plan",
  );
});

test("cancelling a plan aborts an in-flight metadata request through its scoped manager", async (t) => {
  let started;
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  const { directory, url } = await fixture(t, (_, response) => {
    response.writeHead(200, { "Content-Length": 8 });
    response.write("data");
    started();
  });
  const manager = new DownloadManager(directory);
  const plan = manager.createPlan({
    title: "取消元数据",
    stages: [{ id: "metadata", title: "元数据" }],
  });
  plan.startStage("metadata");
  const pending = manager
    .scoped(plan.context("metadata"))
    .download(url, path.join(directory, "cancelled.json"), undefined, 8);
  await requestStarted;
  controlDownload(plan.id, "cancel");
  await assert.rejects(pending, DownloadCancelledError);
  plan.fail(new DownloadCancelledError());
  assert.deepEqual(
    await fs.readdir(directory),
    [],
    "cancelled metadata must not leave an installable destination or partial",
  );
  assert.throws(() => controlDownload(plan.id, "resume"), /已结束/);
});

async function fixture(t, handler) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-download-details-"),
  );
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, url: `http://127.0.0.1:${server.address().port}` };
}

test("a batch announces every expected file before transfer and reports independent file and byte totals", async (t) => {
  let release;
  let started;
  const firstRequest = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { directory, url } = await fixture(t, async (_, response) => {
    started();
    await gate;
    response.end("data");
  });
  const events = [];
  const manager = new DownloadManager(
    directory,
    (event) => events.push(event.task),
    1,
  );
  const items = ["client.jar", "fabric-loader.jar"].map((name) => ({
    url,
    path: path.join(directory, name),
    size: 4,
  }));
  const pending = manager.downloadMany([...items, items[0]], "游戏运行库", {
    resourceName: "Minecraft 1.21.1",
    targetInstanceId: "test",
    targetInstanceName: "我的 Fabric",
  });
  await firstRequest;
  const initial = events[0];
  assert.equal(
    initial.download.totalFiles,
    2,
    "same destination is planned once",
  );
  assert.equal(initial.download.totalBytes, 8);
  assert.equal(initial.download.completedFiles, 0);
  const queued = getDownloadTaskFiles(initial.id);
  assert.deepEqual(
    queued.files.map((file) => file.name),
    ["client.jar", "fabric-loader.jar"],
  );
  assert.equal(queued.files[1].status, "queued");
  assert.ok(!JSON.stringify(queued).includes(directory));
  assert.ok(!JSON.stringify(queued).includes(url));
  release();
  await pending;
  const final = events.at(-1);
  assert.equal(final.status, "completed");
  assert.equal(final.download.receivedBytes, 8);
  assert.equal(final.download.completedFiles, 2);
  assert.equal(final.download.targetInstanceName, "我的 Fabric");
  assert.ok(
    getDownloadTaskFiles(initial.id).files.every(
      (file) => file.status === "completed",
    ),
  );
});

test("chunked downloads keep an unknown total explicit and retain actual bytes on completion", async (t) => {
  const { directory, url } = await fixture(t, (_, response) => {
    response.write("1234");
    setTimeout(() => response.end("56789"), 30);
  });
  const events = [];
  const manager = new DownloadManager(directory, (event) =>
    events.push(event.task),
  );
  await manager.downloadVerified(
    {
      url,
      path: path.join(directory, "private-cache-key"),
      name: "sodium.jar",
    },
    "下载 Sodium",
  );
  const unknown = events.find(
    (event) =>
      event.status === "running" && event.download.totalBytes === undefined,
  );
  assert.ok(unknown);
  assert.equal(unknown.download.progressMode, "files");
  const final = events.at(-1);
  assert.equal(final.download.receivedBytes, 9);
  assert.equal(final.download.totalBytes, 9);
  assert.equal(final.download.completedFiles, 1);
  assert.equal(getDownloadTaskFiles(final.id).files[0].name, "sodium.jar");
});

test("a planned resource list stays grouped and its pause/resume controls apply to subsequent files", async (t) => {
  let requests = 0;
  const { directory, url } = await fixture(t, (_, response) => {
    requests++;
    response.end("data");
  });
  const events = [];
  const manager = new DownloadManager(directory, (event) =>
    events.push(event.task),
  );
  const plan = manager.createPlan({
    title: "安装 Sodium 与前置",
    context: { targetInstanceName: "Fabric" },
    stages: [
      { id: "resolve", title: "解析" },
      { id: "files", title: "内容" },
      { id: "finish", title: "登记" },
    ],
  });
  assert.deepEqual(
    events[0].download.stages.map((stage) => stage.status),
    ["pending", "pending", "pending"],
  );
  plan.startStage("resolve");
  plan.completeStage("resolve");
  plan.setStageFiles("files", [
    { name: "api.jar", size: 4 },
    { name: "sodium.jar", size: 4 },
  ]);
  const listId = events
    .at(-1)
    .download.stages.find((stage) => stage.id === "files").fileListId;
  assert.equal(getDownloadTaskFiles(listId).total, 2);
  plan.startStage("files");
  await manager.downloadVerified(
    { url, path: path.join(directory, "api.jar"), size: 4 },
    "API",
    plan.context("files", "0"),
  );
  controlDownload(plan.id, "pause");
  const second = manager.downloadVerified(
    { url, path: path.join(directory, "sodium.jar"), size: 4 },
    "Sodium",
    plan.context("files", "1"),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(requests, 1, "a later file must wait while its plan is paused");
  assert.equal(events.at(-1).status, "paused");
  controlDownload(plan.id, "resume");
  await second;
  plan.completeStage("files");
  plan.startStage("finish");
  plan.completeStage("finish");
  plan.complete();
  assert.ok(
    events.every((event) => event.id === plan.id),
    "per-file jobs are represented by the declared plan, not thousands of top-level rows",
  );
  assert.ok(
    getDownloadTaskFiles(listId).files.every(
      (file) => file.status === "completed",
    ),
  );
  assert.equal(events.at(-1).download.completedFiles, 2);
  assert.throws(() => controlDownload(plan.id, "pause"), /已结束/);
});

test("cancelling a plan stops a future transfer and releases plan controls", async (t) => {
  let requests = 0;
  const { directory, url } = await fixture(t, (_, response) => {
    requests++;
    response.end("data");
  });
  const events = [];
  const manager = new DownloadManager(directory, (event) =>
    events.push(event.task),
  );
  const plan = manager.createPlan({
    title: "取消整合包",
    stages: [{ id: "files", title: "文件" }],
  });
  plan.startStage("files");
  controlDownload(plan.id, "cancel");
  await assert.rejects(
    manager.downloadMany(
      [{ url, path: path.join(directory, "never.jar") }],
      "文件",
      plan.context("files"),
    ),
    DownloadCancelledError,
  );
  plan.fail(new DownloadCancelledError());
  assert.equal(requests, 0);
  assert.equal(events.at(-1).status, "cancelled");
  assert.throws(() => controlDownload(plan.id, "resume"), /已结束/);
});

test("large expected lists use bounded pages and immutable snapshots without bloating progress events", () => {
  const events = [];
  const manager = new DownloadManager("unused", (event) =>
    events.push(event.task),
  );
  const plan = manager.createPlan({
    title: "大型资源清单",
    stages: [{ id: "assets", title: "资源" }],
  });
  plan.setStageFiles(
    "assets",
    Array.from({ length: 4000 }, (_, index) => ({
      name: `resource-${index}.ogg`,
      size: index,
    })),
  );
  const listId = events.at(-1).download.stages[0].fileListId;
  const page = getDownloadTaskFiles(listId, 50, 100);
  assert.equal(page.total, 4000);
  assert.equal(page.files.length, 100);
  assert.equal(page.files[0].name, "resource-50.ogg");
  page.files[0].name = "tampered";
  assert.equal(
    getDownloadTaskFiles(listId, 50, 1).files[0].name,
    "resource-50.ogg",
  );
  assert.ok(events.every((event) => JSON.stringify(event).length < 2000));
  assert.throws(() => getDownloadTaskFiles(listId, -1), /分页/);
  assert.throws(() => getDownloadTaskFiles(listId, 0, 101), /分页/);
  plan.fail(new Error("controlled end"));
});
