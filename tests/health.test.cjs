const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const AdmZip = require("adm-zip");
const {
  HealthScanner,
  healthJavaMajor,
} = require("@ldfcl/core/services/health");
const settings = {
  memoryMode: "manual",
  memoryMb: 512,
  javaPath: "wrong",
  gameDefaults: {},
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instance = {
    id: "test",
    version: "1.21.1",
    loader: "fabric",
    name: "test",
    versionDirectory: "test",
    gameSettings: {},
  };
  const directory = path.join(root, "versions", "test");
  await fs.mkdir(path.join(directory, "mods"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "test.json"),
    JSON.stringify({ javaVersion: { majorVersion: 21 } }),
  );
  return { root, instance, directory };
}
test("health report aggregates mismatched Java, required mods, low memory and history warnings without exposing logs", async (t) => {
  const { root, instance, directory } = await fixture(t);
  const zip = new AdmZip();
  zip.addFile(
    "fabric.mod.json",
    Buffer.from(
      JSON.stringify({
        id: "example",
        version: "1",
        depends: { fabricloader: "*", minecraft: "*", "fabric-api": "*" },
      }),
    ),
  );
  zip.writeZip(path.join(directory, "mods", "example.jar"));
  await fs.mkdir(path.join(directory, "logs"));
  await fs.writeFile(
    path.join(directory, "logs", "latest.log"),
    "[WARN] secret-never-copy-to-health\n",
  );
  const scanner = new HealthScanner({
    minecraftRoot: root,
    java: {
      inspect: async () => ({
        major: 17,
        architecture: process.arch,
        path: "wrong",
      }),
      discover: async () => [],
    },
    totalMemoryMb: () => 8192,
    freeMemoryMb: () => 4096,
  });
  const report = await scanner.scan(instance, settings);
  assert.equal(report.status, "error");
  for (const category of ["java", "dependency", "memory", "logs"])
    assert.ok(
      report.issues.some((issue) => issue.category === category),
      category,
    );
  assert.ok(report.score < 100);
  assert.ok(!JSON.stringify(report).includes("secret-never-copy"));
  assert.equal(
    report.issues.filter((issue) => issue.category === "dependency").length,
    1,
  );
});
test("health disabled dependency points only to local file that can be enabled", async (t) => {
  const { root, instance, directory } = await fixture(t);
  for (const [name, id, depends] of [
    ["example.jar", "example", { api: "*" }],
    ["api.jar.disabled", "api", {}],
  ]) {
    const zip = new AdmZip();
    zip.addFile(
      "fabric.mod.json",
      Buffer.from(JSON.stringify({ id, version: "1", depends })),
    );
    zip.writeZip(path.join(directory, "mods", name));
  }
  const scanner = new HealthScanner({
    minecraftRoot: root,
    java: {
      inspect: async () => null,
      discover: async () => [
        { major: 21, architecture: process.arch, path: "java" },
      ],
    },
    totalMemoryMb: () => 8192,
    freeMemoryMb: () => 4096,
  });
  const report = await scanner.scan(instance, {
    ...settings,
    javaPath: "",
    memoryMb: 4096,
  });
  const issue = report.issues.find((issue) => issue.category === "dependency");
  assert.equal(issue.autoFix, "enable-dependency");
  assert.equal(issue.file, "api.jar.disabled");
  assert.ok(!report.issues.some((issue) => issue.category === "java"));
});
test("health handles corrupt archives/config and does not claim full dependency solving", async (t) => {
  const { root, instance, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, "test.json"), "{token:PRIVATE");
  await fs.writeFile(path.join(directory, "mods", "broken.jar"), "bad zip");
  const report = await new HealthScanner({
    minecraftRoot: root,
    java: { inspect: async () => null, discover: async () => [] },
  }).scan(instance, { ...settings, javaPath: "", memoryMb: 4096 });
  assert.ok(report.issues.some((issue) => issue.id === "files:version"));
  assert.ok(report.issues.some((issue) => issue.id === "files:mod:broken.jar"));
  assert.ok(report.limits.length);
  assert.ok(!JSON.stringify(report).includes("PRIVATE"));
});
test("health Java fallbacks cover supported generation changes", () => {
  for (const [version, major] of [
    ["1.16.5", 8],
    ["1.17.1", 16],
    ["1.18.2", 17],
    ["1.20.4", 17],
    ["1.20.5", 21],
    ["1.21.1", 21],
    ["26.3", 25],
  ])
    assert.equal(healthJavaMajor(version), major, version);
});
