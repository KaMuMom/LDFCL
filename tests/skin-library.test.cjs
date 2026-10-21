const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const zlib = require("node:zlib");
const {
  SkinLibrary,
} = require("../dist-electron/electron/services/skin-library.js");

function png(width = 64, height = 64, color = 90, extraInflatedBytes = 0) {
  const crc = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(name, 4);
    data.copy(result, 8);
    result.writeUInt32BE(
      crc(result.subarray(4, result.length - 4)),
      result.length - 4,
    );
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(
    (width * 4 + 1) * height + extraInflatedBytes,
    color,
  );
  for (let row = 0; row < height; row++) rows[row * (width * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const input = (name = "森林旅人", variant = "classic", data = png()) => ({
  name,
  variant,
  dataUrl: `data:image/png;base64,${data.toString("base64")}`,
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-skin-library-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "LDFCL-data");
  const skins = path.join(dataDir, "skins");
  return {
    root,
    dataDir,
    skins,
    index: path.join(skins, "index.json"),
    library: new SkinLibrary(dataDir),
  };
}

test("empty local library works without any account or account configuration", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.library.list(), []);
  assert.deepEqual(await fs.readdir(f.dataDir), ["skins"]);
  assert.deepEqual(await fs.readdir(f.skins), []);
});

test("saved PNG, Unicode name, model, and timestamps survive a new service instance", async (t) => {
  const f = await fixture(t);
  const source = input("  雪原旅行者  ", "slim");
  const entry = await f.library.save(source);
  assert.equal(entry.name, "雪原旅行者");
  assert.equal(entry.variant, "slim");
  assert.equal(entry.dataUrl, source.dataUrl);
  assert(Number.isFinite(Date.parse(entry.createdAt)));
  assert.equal(entry.createdAt, entry.updatedAt);
  const restarted = new SkinLibrary(f.dataDir);
  assert.deepEqual(await restarted.list(), [entry]);
  const localFile = await restarted.file(entry.id);
  assert.equal(path.dirname(localFile), f.skins);
  assert.deepEqual(await fs.readFile(localFile), png());
  const index = JSON.parse(await fs.readFile(f.index, "utf8"));
  assert(
    !JSON.stringify(index).includes("data:image"),
    "index should contain metadata, with PNG separately stored",
  );
});

test("classic legacy 64x32 skin and same-name skins are independent library entries", async (t) => {
  const { library } = await fixture(t);
  const legacy = await library.save(input("我的皮肤", "classic", png(64, 32)));
  const modern = await library.save(input("我的皮肤", "slim"));
  assert.notEqual(legacy.id, modern.id);
  const entries = await library.list();
  assert.equal(entries.length, 2);
  assert(
    entries.some(
      (entry) => entry.id === legacy.id && entry.variant === "classic",
    ),
  );
});

test("names never form local paths or overwrite files outside the library", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "keep.png");
  await fs.writeFile(outside, "original");
  const entry = await f.library.save(input("../../keep.png"));
  assert.equal(await fs.readFile(outside, "utf8"), "original");
  assert.equal(
    path.basename(await f.library.file(entry.id)),
    `${entry.id}.png`,
  );
});

test("remote URLs, local paths, wrong MIME, and malformed base64 are rejected before writing", async (t) => {
  const f = await fixture(t);
  for (const dataUrl of [
    "https://example.com/skin.png",
    "file:///C:/skin.png",
    "C:\\skin.png",
    "data:image/jpeg;base64,AAAA",
    "data:image/png;base64,###=",
    "data:image/png;base64,AAAA\n",
    "data:image/png;base64,AA==junk",
  ])
    await assert.rejects(f.library.save({ ...input(), dataUrl }), /PNG|皮肤/);
  assert.deepEqual(await f.library.list(), []);
});

test("non-PNG and unsupported dimensions do not enter the library", async (t) => {
  const { library } = await fixture(t);
  await assert.rejects(
    library.save(input("bad", "classic", Buffer.from("not a PNG"))),
    /PNG/,
  );
  await assert.rejects(
    library.save(input("bad", "classic", png(128, 64))),
    /64/,
  );
  await assert.rejects(
    library.save(input("bad", "classic", png(64, 48))),
    /64/,
  );
  assert.deepEqual(await library.list(), []);
});

test("truncated PNG headers, CRC damage, and compressed pixel bombs are rejected", async (t) => {
  const { library } = await fixture(t);
  const corrupt = png();
  corrupt[corrupt.length - 1] ^= 1;
  for (const data of [
    png().subarray(0, 24),
    corrupt,
    png(64, 64, 90, 1024 * 1024),
  ])
    await assert.rejects(library.save(input("broken", "classic", data)), /PNG/);
  assert.deepEqual(await library.list(), []);
});

test("2 MB input limit is enforced on decoded data, including a valid-looking PNG prefix", async (t) => {
  const { library } = await fixture(t);
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
  png().copy(oversized);
  await assert.rejects(
    library.save(input("large", "classic", oversized)),
    /2 MB/,
  );
  assert.deepEqual(await library.list(), []);
});

test("invalid names and models are rejected without changing a saved library", async (t) => {
  const { library } = await fixture(t);
  const entry = await library.save(input());
  for (const name of ["", "   ", "hello\nworld", "a".repeat(81)])
    await assert.rejects(library.save(input(name)), /名称/);
  await assert.rejects(library.save(input("wrong", "unknown")), /模型/);
  await assert.rejects(library.rename(entry.id, "\0bad"), /名称/);
  assert.deepEqual(await library.list(), [entry]);
});

test("untrusted IDs cannot address outside paths in read, rename, or delete", async (t) => {
  const { library } = await fixture(t);
  const entry = await library.save(input());
  for (const id of [
    "../index",
    "C:\\accounts.json",
    "https://example.com/skin.png",
    "",
    "../" + entry.id,
  ]) {
    await assert.rejects(library.file(id), /标识/);
    await assert.rejects(library.rename(id, "new"), /标识/);
    await assert.rejects(library.remove(id), /标识/);
  }
  await assert.rejects(library.file(randomUUID()), /不存在/);
  assert.deepEqual(await library.list(), [entry]);
});

test("renaming preserves the skin bytes, ID, and creation time", async (t) => {
  const { library } = await fixture(t);
  const original = await library.save(input());
  const file = await library.file(original.id);
  const changed = await library.rename(original.id, "  日落旅人  ");
  assert.equal(changed.id, original.id);
  assert.equal(changed.name, "日落旅人");
  assert.equal(changed.createdAt, original.createdAt);
  assert.equal(changed.dataUrl, original.dataUrl);
  assert.equal(await library.file(changed.id), file);
  assert.deepEqual(await library.list(), [changed]);
});

test("deleting a saved skin removes its PNG and record but preserves an exported copy", async (t) => {
  const f = await fixture(t);
  const entry = await f.library.save(input());
  const local = await f.library.file(entry.id);
  const exported = path.join(f.root, "exported.png");
  await fs.copyFile(local, exported);
  await f.library.remove(entry.id);
  assert.deepEqual(await new SkinLibrary(f.dataDir).list(), []);
  await assert.rejects(fs.stat(local), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(exported), png());
  await assert.rejects(f.library.file(entry.id), /不存在/);
});

test("concurrent saves, renames, and removals serialize without losing entries", async (t) => {
  const f = await fixture(t);
  const saved = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      f.library.save(input(`皮肤 ${i}`, i % 2 ? "slim" : "classic")),
    ),
  );
  await Promise.all(
    saved.map((entry, index) =>
      index % 3
        ? f.library.rename(entry.id, `已改名 ${index}`)
        : f.library.remove(entry.id),
    ),
  );
  const expected = saved
    .filter((_, index) => index % 3)
    .map((entry) => entry.id)
    .sort();
  const persisted = await new SkinLibrary(f.dataDir).list();
  assert.deepEqual(persisted.map((entry) => entry.id).sort(), expected);
  assert.equal(
    (await fs.readdir(f.skins)).filter((name) => name.endsWith(".png")).length,
    expected.length,
  );
  assert(persisted.every((entry) => entry.name.startsWith("已改名")));
});

test("failed atomic index publication preserves old data, cleans its PNG/temp, and queue recovers", async (t) => {
  const f = await fixture(t);
  const original = await f.library.save(input("原皮肤"));
  const oldIndex = await fs.readFile(f.index);
  const oldNames = (await fs.readdir(f.skins)).sort();
  const rename = fs.rename;
  fs.rename = async function (from, to) {
    if (to === f.index) {
      const error = new Error("publication denied");
      error.code = "EACCES";
      throw error;
    }
    return rename.call(this, from, to);
  };
  try {
    await assert.rejects(
      f.library.save(input("不应出现")),
      /publication denied/,
    );
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(await fs.readFile(f.index), oldIndex);
  assert.deepEqual((await fs.readdir(f.skins)).sort(), oldNames);
  assert.deepEqual(await f.library.list(), [original]);
  await f.library.save(input("恢复后"));
  assert.equal((await f.library.list()).length, 2);
});

test("failed rename publication retains the previous name after restarting", async (t) => {
  const f = await fixture(t);
  const original = await f.library.save(input("旧名称"));
  const rename = fs.rename;
  fs.rename = async function (from, to) {
    if (to === f.index) throw new Error("rename failed");
    return rename.call(this, from, to);
  };
  try {
    await assert.rejects(
      f.library.rename(original.id, "新名称"),
      /rename failed/,
    );
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(await new SkinLibrary(f.dataDir).list(), [original]);
});

test("malformed existing index is reported and never overwritten by save", async (t) => {
  const f = await fixture(t);
  await f.library.list();
  await fs.writeFile(f.index, "{broken-index");
  await assert.rejects(f.library.list());
  await assert.rejects(f.library.save(input()));
  assert.equal(await fs.readFile(f.index, "utf8"), "{broken-index");
  assert.deepEqual(await fs.readdir(f.skins), ["index.json"]);
});

test("index cannot inject a traversal ID, duplicate IDs, or an unsupported model", async (t) => {
  const f = await fixture(t);
  const entry = await f.library.save(input());
  const { dataUrl, ...record } = entry;
  for (const records of [
    [{ ...record, id: "../../outside" }],
    [record, record],
    [{ ...record, variant: "invalid" }],
  ]) {
    await fs.writeFile(
      f.index,
      JSON.stringify({ version: 1, entries: records }),
    );
    await assert.rejects(f.library.list(), /标识|重复|模型/);
  }
});

test("a junction used as the skins directory is rejected without touching its target", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "unrelated");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "keep.txt"), "keep");
  await fs.mkdir(f.dataDir);
  await fs.symlink(target, f.skins, "junction");
  await assert.rejects(f.library.list(), /链接|联接/);
  await assert.rejects(f.library.save(input()), /链接|联接/);
  assert.deepEqual(await fs.readdir(target), ["keep.txt"]);
});

test("a directory masquerading as index.json is rejected", async (t) => {
  const f = await fixture(t);
  await f.library.list();
  await fs.mkdir(f.index);
  await assert.rejects(f.library.save(input()), /特殊文件/);
  assert((await fs.stat(f.index)).isDirectory());
});

test("mutated or oversized PNG files cannot be supplied for export or account upload", async (t) => {
  const f = await fixture(t);
  const entry = await f.library.save(input());
  const file = await f.library.file(entry.id);
  await fs.writeFile(file, "not an image");
  await assert.rejects(f.library.file(entry.id), /PNG/);
  await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(f.library.file(entry.id), /2 MB/);
});

test("returned entries are detached snapshots rather than mutable service state", async (t) => {
  const { library } = await fixture(t);
  const entry = await library.save(input());
  const listed = await library.list();
  listed[0].name = "injected";
  listed[0].dataUrl = "https://example.com/not-local.png";
  assert.deepEqual(await library.list(), [entry]);
});
