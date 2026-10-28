const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store, validateSettings } = require("@ldfcl/core/store");
const { createUiEventBuffer } = require("@ldfcl/core/shared/ui-event-buffer");

test("interface mode defaults safely for new and invalid legacy settings and persists a user choice", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-ui-mode-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let store = new Store(dir);
  await store.load();
  assert.equal(store.settings.interfacePerformance, "efficient");
  await store.updateSettings({ interfacePerformance: "quality" });
  store = new Store(dir);
  await store.load();
  assert.equal(store.settings.interfacePerformance, "quality");
  await assert.rejects(
    store.updateSettings({ interfacePerformance: "turbo" }),
    /界面性能/,
  );
  assert.equal(store.settings.interfacePerformance, "quality");
  const file = path.join(dir, "launcher.json");
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(disk.settings.interfacePerformance, "quality");
  disk.settings.interfacePerformance = "turbo";
  await fs.writeFile(file, JSON.stringify(disk));
  store = new Store(dir);
  await store.load();
  assert.equal(store.settings.interfacePerformance, "efficient");
  assert.deepEqual(validateSettings({ interfacePerformance: "efficient" }), {
    interfacePerformance: "efficient",
  });
});

function scheduler() {
  const jobs = new Set();
  return {
    jobs,
    schedule(fn) {
      jobs.add(fn);
      return () => jobs.delete(fn);
    },
    tick() {
      for (const fn of [...jobs]) {
        jobs.delete(fn);
        fn();
      }
    },
  };
}

test("bursts publish once with the final task state and ordered, bounded instance logs", () => {
  const clock = scheduler();
  const batches = [];
  const buffer = createUiEventBuffer(
    (batch) => batches.push(batch),
    clock.schedule,
  );
  for (let i = 0; i < 1200; i++) {
    buffer.task({
      id: "download",
      title: "Game",
      status: "downloading",
      progress: i,
    });
    buffer.log("instance-a", `line-${i}`);
  }
  buffer.task({
    id: "download",
    title: "Game",
    status: "completed",
    progress: 100,
  });
  buffer.task({
    id: "failed",
    title: "Other",
    status: "error",
    detail: "connection",
  });
  buffer.log("instance-b", "first\r\nsecond");
  assert.equal(clock.jobs.size, 1);
  assert.equal(batches.length, 0);
  clock.tick();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].tasks.download.status, "completed");
  assert.equal(batches[0].tasks.failed.status, "error");
  assert.equal(batches[0].logs["instance-a"].length, 500);
  assert.equal(batches[0].logs["instance-a"][0], "line-700");
  assert.equal(batches[0].logs["instance-a"].at(-1), "line-1199");
  assert.deepEqual(batches[0].logs["instance-b"], ["first", "second"]);
  buffer.log("instance-a", "next");
  clock.tick();
  assert.deepEqual(batches[1].logs["instance-a"], ["next"]);
  assert.equal(batches[0].logs["instance-a"].length, 500);
  buffer.dispose();
});

test("unmount cancels pending work and manual flush cannot duplicate a batch", () => {
  const clock = scheduler();
  let count = 0;
  const buffer = createUiEventBuffer(() => count++, clock.schedule);
  buffer.log("launcher", "first");
  buffer.flush();
  clock.tick();
  assert.equal(count, 1);
  buffer.log("launcher", "pending");
  buffer.dispose();
  buffer.task({ id: "late", title: "late", status: "completed" });
  buffer.log("launcher", "late");
  buffer.flush();
  clock.tick();
  assert.equal(clock.jobs.size, 0);
  assert.equal(count, 1);
});
