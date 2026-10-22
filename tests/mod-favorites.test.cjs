const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const { ModFavorites } = require(
  path.join(compiledRoot, "core/services/mod-favorites.js"),
);
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-favorites-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    service: new ModFavorites(root),
    file: path.join(root, "mod-favorites.json"),
  };
}
const project = (projectId, extra = {}) => ({
  projectId,
  slug: projectId,
  title: projectId,
  ...extra,
});
test("favorites persist across service restarts, update by project ID and omit unknown or unsafe fields", async (t) => {
  const { root, service, file } = await fixture(t);
  assert.deepEqual(await service.list(), []);
  await service.set(
    project("sodium", {
      displayName: "钠",
      description: "中文简介",
      iconUrl: "javascript:bad",
      token: "must-not-persist",
    }),
    true,
  );
  const list = await new ModFavorites(root).list();
  assert.equal(list[0].displayName, "钠");
  assert.equal(list[0].iconUrl, undefined);
  assert(!JSON.stringify(list).includes("token"));
  await service.set(project("sodium", { title: "Updated Sodium" }), true);
  assert.equal((await service.list()).length, 1);
  assert.equal((await service.list())[0].title, "Updated Sodium");
  await service.set({ projectId: "sodium" }, false);
  assert.deepEqual(await new ModFavorites(root).list(), []);
  assert(!String(await fs.readFile(file)).includes("must-not-persist"));
});
test("concurrent favorites retain all projects and removal remains effective after restarting", async (t) => {
  const { root, service } = await fixture(t);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      service.set(project(`mod-${index}`), true),
    ),
  );
  assert.equal((await service.list()).length, 20);
  await service.set({ projectId: "mod-3" }, false);
  assert(
    !(await new ModFavorites(root).list()).some(
      (mod) => mod.projectId === "mod-3",
    ),
  );
});
test("failed publication preserves the previous favorites and the next operation can retry", async (t) => {
  const { root, service, file } = await fixture(t);
  await service.set(project("original"), true);
  const before = await fs.readFile(file);
  const rename = fs.rename;
  let fail = true;
  fs.rename = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error("simulated favorites publish failure");
    }
    return rename(...args);
  };
  t.after(() => {
    fs.rename = rename;
  });
  await assert.rejects(service.set(project("failed"), true), /publish failure/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  await service.set(project("retry"), true);
  assert.deepEqual(
    (await service.list()).map((mod) => mod.projectId),
    ["retry", "original"],
  );
});
test("invalid payloads and corrupt or oversized configuration fail without replacing the original file", async (t) => {
  const { service, file } = await fixture(t);
  await assert.rejects(service.set(project("../bad"), true), /标识/);
  await assert.rejects(service.set({ projectId: "valid" }, true), /标识|名称/);
  await assert.rejects(service.set(project("valid"), "yes"), /状态/);
  await fs.writeFile(file, "broken original JSON");
  await assert.rejects(service.set(project("valid"), true));
  assert.equal(await fs.readFile(file, "utf8"), "broken original JSON");
  await fs.truncate(file, 2 * 1024 * 1024 + 1);
  await assert.rejects(service.list(), /配置文件/);
});
