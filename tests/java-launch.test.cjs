const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const nativeFs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const AdmZip = require("adm-zip");
const compiledRoot = process.env.LDFCL_TEST_COMPILED_ROOT || path.join(__dirname, "..", "core", "dist");
const { prepareJavaLaunch, manifestClasspath } = require(path.join(compiledRoot, "core", "services", "java-launch.js"));
const bytecode = require(path.join(compiledRoot, "core", "services", "java-bootstrap-bytecode.js"));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-launch-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("ordinary short ASCII invocations keep the original JVM/process arguments", async (t) => {
  const root = await fixture(t);
  const invocation = await prepareJavaLaunch({ executable: "java", jvmArguments: ["-Xmx2048M", "-cp", "client.jar"], mainClass: "game.Main", gameArguments: ["--username", "Fixture"], classpath: ["client.jar"], cwd: root });
  assert.equal(invocation.executable, "java");
  assert.deepEqual(invocation.args, ["-Xmx2048M", "-cp", "client.jar", "game.Main", "--username", "Fixture"]);
  assert.equal(invocation.stdin, undefined);
  assert.equal(invocation.directory, undefined);
  await invocation.dispose();
  assert.deepEqual(await fs.readdir(root), []);
});

test("the embedded Java 8 helper is linked to its retained source and integrity hash", async () => {
  const bytes = Buffer.from(bytecode.JAVA_BOOTSTRAP_CLASS_BASE64, "base64");
  assert.equal(bytes.readUInt32BE(0), 0xcafebabe);
  assert.equal(bytes.readUInt16BE(6), 52);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), bytecode.JAVA_BOOTSTRAP_CLASS_SHA256);
  const source = await fs.readFile(path.join(__dirname, "..", "build", "java", "LaunchBootstrap.java"));
  assert.equal(createHash("sha256").update(source).digest("hex"), bytecode.JAVA_BOOTSTRAP_SOURCE_SHA256);
});

test("classpath manifests preserve supplementary filenames and encode unsafe URL characters", () => {
  const files = [path.resolve("中文 # 😄", "part one%25.jar"), ...Array.from({ length: 80 }, (_, index) => path.resolve(`library-${index}.jar`))];
  const manifest = manifestClasspath(files);
  assert(!/[^\x00-\x7f]/.test(manifest));
  assert(manifest.split("\r\n").every((line) => Buffer.byteLength(line) <= 72));
  const unfolded = manifest.replace(/\r\n /g, "");
  assert(unfolded.includes("%F0%9F%98%84"));
  assert(unfolded.includes("%23"));
  assert(unfolded.includes("%25"));
  assert.equal(unfolded.match(/library-\d+\.jar/g).length, 80);
});

test("long classpaths use the system-loader manifest and keep token arguments only in the pipe", async (t) => {
  const root = await fixture(t);
  const classpath = Array.from({ length: 600 }, (_, index) => path.join(root, `dependency-${index}-${"x".repeat(40)}.jar`));
  const token = "private-synthetic-access-token";
  const invocation = await prepareJavaLaunch({ executable: "java", jvmArguments: ["-Xmx2048M", "-cp", classpath.join(path.delimiter)], mainClass: "game.Main", gameArguments: ["--accessToken", token, "😄 quoted \"name\"\\"], classpath, cwd: root, temporaryRoot: root });
  t.after(() => invocation.dispose());
  assert(invocation.directory);
  assert(invocation.stdin.includes(Buffer.from(token)));
  assert(!invocation.args.join(" ").includes(token));
  assert(invocation.args.join(" ").length < 1000);
  const entries = await fs.readdir(invocation.directory, { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isFile()).map((entry) => entry.name), ["bootstrap.jar"]);
  const archive = new AdmZip(await fs.readFile(path.join(invocation.directory, "bootstrap.jar")));
  const manifest = archive.readAsText("META-INF/MANIFEST.MF").replace(/\r\n /g, "");
  assert.equal(manifest.match(/dependency-\d+-/g).length, 600);
  assert(!manifest.includes(token));
  assert(archive.getEntry("io/ldfcl/launch/LaunchBootstrap.class"));
  await invocation.dispose();
  await invocation.dispose();
  assert.equal(nativeFs.existsSync(invocation.directory), false);
});

test("Windows compatibility cleanup unlinks aliases while preserving game directories", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fixture(t);
  const game = path.join(root, "中文 # 😄", "versions", "fixture");
  const natives = path.join(game, ".ldfcl", "natives");
  await fs.mkdir(natives, { recursive: true });
  const save = path.join(game, "world-sentinel.txt");
  await fs.writeFile(save, "keep-world");
  const invocation = await prepareJavaLaunch({ executable: "java", jvmArguments: [`-Djava.library.path=${natives}`, "-cp", path.join(game, "client.jar")], mainClass: "game.Main", gameArguments: ["--gameDir", game], classpath: [path.join(game, "client.jar")], cwd: game, roots: [path.dirname(path.dirname(game))], temporaryRoot: root });
  t.after(() => invocation.dispose());
  assert(!/[^\x20-\x7e]/.test(invocation.cwd));
  assert.equal(await fs.realpath(invocation.cwd), await fs.realpath(game));
  assert(invocation.args.every((argument) => !/[^\x20-\x7e]/.test(argument)));
  await invocation.dispose();
  assert.equal(nativeFs.existsSync(invocation.directory), false);
  assert.equal(await fs.readFile(save, "utf8"), "keep-world");
  assert((await fs.stat(natives)).isDirectory());
});

test("a rejected VM option cleans its staging aliases without touching source data", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fixture(t);
  const game = path.join(root, "game-😄");
  await fs.mkdir(game);
  await fs.writeFile(path.join(game, "sentinel"), "original");
  const before = await fs.readdir(root);
  await assert.rejects(prepareJavaLaunch({ executable: "java", jvmArguments: ["-Xunsupported=😄", "-cp", "client.jar"], mainClass: "game.Main", gameArguments: [], classpath: [path.join(game, "client.jar")], cwd: game, temporaryRoot: root }), /无法兼容/);
  assert.deepEqual(await fs.readdir(root), before);
  assert.equal(await fs.readFile(path.join(game, "sentinel"), "utf8"), "original");
});

test("a Unicode Windows TEMP uses an ASCII fallback without changing environment or game files", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fixture(t);
  const temporary = path.join(root, "temp-😄");
  await fs.mkdir(temporary);
  const invocation = await prepareJavaLaunch({ executable: "java", jvmArguments: ["-Dfixture=😄", "-cp", "client.jar"], mainClass: "game.Main", gameArguments: [], classpath: [path.join(root, "client.jar")], cwd: root, temporaryRoot: temporary });
  t.after(() => invocation.dispose());
  assert(!/[^\x20-\x7e]/.test(invocation.directory));
  assert.equal(await fs.realpath(invocation.cwd), await fs.realpath(root));
  await invocation.dispose();
  assert.equal(nativeFs.existsSync(invocation.directory), false);
  assert((await fs.stat(temporary)).isDirectory());
});

test("a synchronous child creation failure releases the bridge and records a real launch error", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fixture(t);
  const id = "fixture-😄";
  const game = path.join(root, "versions", id);
  await fs.mkdir(game, { recursive: true });
  const client = path.join(game, `${id}.jar`);
  await fs.writeFile(client, "unchanged-client");
  await fs.writeFile(path.join(game, `${id}.json`), JSON.stringify({ id, mainClass: "game.Main", libraries: [], arguments: { game: ["--gameDir", "${game_directory}"] } }));
  const bridge = require(path.join(compiledRoot, "core", "services", "java-launch.js"));
  const original = bridge.prepareJavaLaunch;
  let invocation;
  t.mock.method(bridge, "prepareJavaLaunch", async (input) => { invocation = await original(input); return invocation; });
  t.mock.method(require("node:child_process"), "spawn", () => { throw Error("injected synchronous child creation failure"); });
  const { GameService } = require(path.join(compiledRoot, "core", "services", "game.js"));
  const events = [];
  const service = new GameService(root, (event) => events.push(event), { minecraftRoot: root });
  service.java.ensure = async () => "fixture-java.exe";
  await assert.rejects(service.launch({ id: "fixture", name: id, version: "1.16.5", loader: "vanilla", importedVersionId: id, versionDirectory: id, gameSettings: {} }, { id: "probe", type: "offline", name: "Probe", uuid: "0123456789abcdef0123456789abcdef" }, { downloadConcurrency: 2, memoryMode: "manual", memoryMb: 512 }), /injected synchronous/);
  assert(invocation.directory);
  assert.equal(nativeFs.existsSync(invocation.directory), false);
  assert.equal(service.running.size, 0);
  assert.equal(service.sessions.size, 0);
  assert(events.some((event) => event.type === "game" && event.status === "error"));
  assert.equal(await fs.readFile(client, "utf8"), "unchanged-client");
});
