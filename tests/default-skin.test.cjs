const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const { DEFAULT_SKIN_NAME, defaultSkinTexture } = require(
  path.join(compiledRoot, "shared", "default-skin.js"),
);

test("default preview uses the unchanged bundled official Steve template without a network URL", async () => {
  const uri = defaultSkinTexture();
  assert.equal(DEFAULT_SKIN_NAME, "Steve");
  assert.equal(
    new URL(uri, "https://launcher.invalid/index.html").origin,
    "https://launcher.invalid",
  );
  assert.equal(
    new URL(uri, "file:///C:/portable/app/dist/index.html").pathname,
    "/C:/portable/app/dist/skins/steve.png",
  );
  const asset = await fs.readFile(path.join(__dirname, "..", "public", uri));
  assert.equal(asset.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(asset.readUInt32BE(16), 64);
  assert.equal(asset.readUInt32BE(20), 64);
  assert.equal(asset[24], 8);
  assert.equal(asset[25], 6);
  assert.equal(
    createHash("sha256").update(asset).digest("hex"),
    "4c7b0468044bfecacc43d00a3a69335a834b73937688292c20d3988cae58248d",
  );
});
