const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { captureJavaStdin, decodedJavaInvocation } = require("./helpers/java-invocation.cjs");
const AdmZip = require("adm-zip");
const compiledRoot =
  process.env.LDFCL_TEST_COMPILED_ROOT ||
  path.join(__dirname, "..", "core", "dist");
const { JavaManager, javaMajor } = require(
  path.join(compiledRoot, "core/services/java.js"),
);
const {
  parseJavaInstallation,
  normalizeJavaArchitecture,
  compatibleJavaArchitecture,
  javaExecutables,
  realJavaExecutable,
} = require(path.join(compiledRoot, "core/services/java-runtime.js"));
const {
  prepareJvmArguments,
  nativeClassifier,
  nativeExtractionAllowed,
} = require(path.join(compiledRoot, "core/services/launch-preparation.js"));
const { GameService, expandArguments } = require(
  path.join(compiledRoot, "core/services/game.js"),
);
const downloadsModule = require(
  path.join(compiledRoot, "core/services/downloads.js"),
);

async function temporary(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-java-preparation-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
function spawnFixture(t, output, capture = () => {}) {
  t.mock.method(
    require("node:child_process"),
    "spawn",
    (executable, args, options) => {
      capture(executable, args, options);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 43210;
      queueMicrotask(() => {
        child.stderr.end(output);
        child.emit("close", 0);
      });
      return child;
    },
  );
}

test("Java properties identify vendor-neutral runtime version, home and architecture", () => {
  const info = parseJavaInstallation(
    "Property settings:\n    java.version = 21.0.8\n    java.home = C:\\Java 安装\\jdk-21\n    os.arch = amd64\n",
    "java",
  );
  assert.equal(info.major, 21);
  assert.equal(info.version, "21.0.8");
  assert.equal(info.architecture, "x64");
  assert.equal(
    realJavaExecutable(info, "win32"),
    "C:\\Java 安装\\jdk-21\\bin\\java.exe",
  );
  assert.equal(javaMajor("    java.specification.version = 1.8\n"), 8);
  assert.equal(javaMajor('java version "1"'), null);
  assert.equal(normalizeJavaArchitecture("i686"), "ia32");
  assert.equal(normalizeJavaArchitecture("aarch64"), "arm64");
  assert.equal(
    compatibleJavaArchitecture({ architecture: "ia32" }, "x64"),
    false,
  );
  assert.equal(
    compatibleJavaArchitecture({ architecture: "arm64" }, "x64"),
    false,
  );
  assert.equal(
    compatibleJavaArchitecture(
      parseJavaInstallation("java.version = 21.0.8\nos.arch = ppc64\n", "java"),
      "x64",
    ),
    false,
  );
  assert.equal(
    compatibleJavaArchitecture({ architecture: "x64" }, "x64"),
    true,
  );
});

test("Java paths accept quoted homes, bin directories and javaw while preserving spaces", () => {
  assert.deepEqual(javaExecutables('"C:\\Java 安装\\jdk 21"', "win32"), [
    "C:\\Java 安装\\jdk 21\\bin\\java.exe",
  ]);
  assert.deepEqual(javaExecutables("C:\\portable\\Java", "win32"), [
    "C:\\portable\\Java\\bin\\java.exe",
  ]);
  assert.deepEqual(javaExecutables("C:\\Java 安装\\jdk 21\\bin", "win32"), [
    "C:\\Java 安装\\jdk 21\\bin\\java.exe",
  ]);
  assert.deepEqual(
    javaExecutables("C:\\Java 安装\\jdk 21\\bin\\javaw.exe", "win32"),
    ["C:\\Java 安装\\jdk 21\\bin\\java.exe"],
  );
  assert.deepEqual(javaExecutables("java", "win32"), ["java"]);
});

test("Java inspection resolves a PATH shim to the actual runtime executable", async (t) => {
  const root = await temporary(t);
  const home = path.join(root, "Java 安装 21");
  const actual = path.join(
    home,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  await write(actual, "fixture");
  let invocation;
  spawnFixture(
    t,
    `Property settings:\n    java.version = 21.0.8\n    java.home = ${home}\n    os.arch = ${process.arch}\n`,
    (executable, args) => {
      invocation = { executable, args };
    },
  );
  const info = await new JavaManager(root).inspect("java");
  assert.equal(info.path, await fs.realpath(actual));
  assert.equal(info.architecture, process.arch);
  assert.equal(invocation.executable, "java");
  assert.deepEqual(invocation.args, ["-XshowSettings:properties", "-version"]);
});

test("Java discovery inspects every existing PATH/JDK_HOME candidate with bounded processes", async (t) => {
  const root = await temporary(t);
  const a = path.join(root, "first");
  const b = path.join(root, "second");
  const home = path.join(root, "custom-home");
  const executable = process.platform === "win32" ? "java.exe" : "java";
  await write(path.join(a, executable), "a");
  await write(path.join(b, executable), "b");
  await write(path.join(home, "bin", executable), "home");
  const prior = {
    PATH: process.env.PATH,
    JAVA_HOME: process.env.JAVA_HOME,
    JDK_HOME: process.env.JDK_HOME,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.PATH = [a, b, path.join(root, "missing")].join(path.delimiter);
  delete process.env.JAVA_HOME;
  process.env.JDK_HOME = home;
  const manager = new JavaManager(root);
  manager.runtimeCandidates = async () => [];
  let active = 0,
    peak = 0;
  const probed = [];
  manager.inspect = async (value) => {
    active++;
    peak = Math.max(peak, active);
    probed.push(value);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active--;
    return {
      path: value,
      major: 21,
      version: "21",
      architecture: process.arch,
    };
  };
  await manager.discover();
  for (const expected of [
    path.join(a, executable),
    path.join(b, executable),
    path.join(home, "bin", executable),
  ])
    assert(probed.includes(expected), expected);
  assert(!probed.some((value) => value.includes("missing")));
  assert(peak > 1 && peak <= 4);
});

test("automatic Java selection rejects an installed wrong architecture without replacing exact version policy", async () => {
  const manager = new JavaManager(os.tmpdir());
  const good = path.join(os.tmpdir(), "java21", "bin", "java.exe");
  manager.discover = async () => [
    {
      path: path.join(os.tmpdir(), "java32.exe"),
      major: 21,
      version: "21",
      architecture: process.arch === "ia32" ? "x64" : "ia32",
    },
    { path: good, major: 21, version: "21", architecture: process.arch },
  ];
  assert.equal(await manager.ensure(21), good);
  manager.inspect = async (value) => ({
    path: value,
    major: 21,
    version: "21",
    architecture: "ia32",
  });
  if (process.arch !== "ia32")
    await assert.rejects(manager.ensure(21, good), /架构/);
  await assert.rejects(manager.ensure(8, good), /需要 Java 8/);
  await assert.rejects(manager.ensure(NaN), /无效/);
});

test("Java provisioning is shared while running and can retry after a failure", async () => {
  const manager = new JavaManager(os.tmpdir());
  let attempts = 0;
  manager.ensureAutomatic = async () => {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 8));
    if (attempts === 1) throw new Error("fixture failure");
    return "runtime-java";
  };
  const failed = await Promise.allSettled([
    manager.ensure(21),
    manager.ensure(21),
  ]);
  assert(failed.every((result) => result.status === "rejected"));
  assert.equal(attempts, 1);
  assert.deepEqual(
    await Promise.all([manager.ensure(21), manager.ensure(21)]),
    ["runtime-java", "runtime-java"],
  );
  assert.equal(attempts, 2);
});

async function provisioningFixture(t, architecture = process.arch) {
  const root = await temporary(t);
  const zip = new AdmZip();
  zip.addFile(
    `jdk/bin/${process.platform === "win32" ? "java.exe" : "java"}`,
    Buffer.from("fixture"),
  );
  const bytes = zip.toBuffer();
  const checksum = createHash("sha256").update(bytes).digest("hex");
  t.mock.method(downloadsModule, "requestJson", async () => [
    {
      binary: {
        package: {
          link: "https://example.invalid/runtime.zip",
          size: bytes.length,
          checksum,
        },
      },
    },
  ]);
  const manager = new JavaManager(root, () => {}, {
    downloadVerified: async (item, label) => {
      assert.equal(item.sha256, checksum);
      assert.equal(item.requireHttps, true);
      assert.equal(item.size, bytes.length);
      assert.equal(label, "自动补齐 Java 21");
      await write(item.path, bytes);
    },
  });
  manager.discover = async () => [];
  manager.inspect = async (executable) => ({
    path: executable,
    major: 21,
    version: "21",
    architecture,
  });
  return { root, manager };
}

test("verified Java package is staged before publishing and never mixed into an older runtime", async (t) => {
  const { root, manager } = await provisioningFixture(t);
  const old = path.join(root, "runtime", "java-21-x64", "old-file");
  await write(old, "preserve");
  const result = await manager.ensure(21);
  assert.equal(await fs.readFile(result, "utf8"), "fixture");
  assert(!result.includes(".java-"));
  assert.equal(await fs.readFile(old, "utf8"), "preserve");
  const entries = await fs.readdir(path.join(root, "runtime"));
  assert(
    !entries.some((name) => name.startsWith(".java-") || name.endsWith(".zip")),
  );
});

test("wrong-architecture Java package is rejected without publishing partial runtime", async (t) => {
  const { root, manager } = await provisioningFixture(
    t,
    process.arch === "ia32" ? "x64" : "ia32",
  );
  await assert.rejects(manager.ensure(21), /架构不匹配/);
  assert.deepEqual(await fs.readdir(path.join(root, "runtime")), []);
});

test("bad Java package digests never replace the cached archive or report completed", async (t) => {
  const root = await temporary(t);
  const expected = Buffer.from("expected valid Java archive");
  const checksum = createHash("sha256").update(expected).digest("hex");
  const architecture =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "ia32"
        ? "x86"
        : "x64";
  const archive = path.join(root, "runtime", `java-21-${architecture}.zip`);
  const previous = Buffer.from(
    "previous archive must survive failed downloads",
  );
  await write(archive, previous);
  t.mock.method(downloadsModule, "requestJson", async (url) => {
    if (url.includes("adoptium"))
      return [
        {
          binary: {
            package: {
              link: "https://example.invalid/adoptium.zip",
              size: expected.length,
              checksum,
            },
          },
        },
      ];
    if (url.includes("fixture-package"))
      return {
        download_url: "https://example.invalid/azul.zip",
        sha256_hash: checksum,
      };
    return [{ package_uuid: "fixture-package", name: "jre.zip" }];
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const response = new Response(Buffer.alloc(expected.length, "x"), {
      headers: { "content-length": String(expected.length) },
    });
    Object.defineProperty(response, "url", { value: String(url) });
    return response;
  });
  const events = [];
  const manager = new JavaManager(root, (event) => events.push(event));
  manager.discover = async () => [];
  await assert.rejects(manager.ensure(21), /无法自动获取 Java 21/);
  assert.deepEqual(await fs.readFile(archive), previous);
  assert.equal(
    events.some((event) => event.task?.status === "completed"),
    false,
  );
  assert.equal(
    events.filter((event) => event.task?.status === "failed").length,
    2,
  );
  assert.deepEqual(await fs.readdir(path.join(root, "runtime")), [
    path.basename(archive),
  ]);
});

test("JVM preparation fixes missing or duplicate classpaths, native path and metadata memory overrides", () => {
  const args = prepareJvmArguments(
    [
      "-Dkeep=yes",
      "-Xmx32M",
      "-Xms16M",
      "--class-path=old.jar",
      "-cp",
      "other.jar",
      "-Djava.library.path=old",
      "-Djava.library.path=other",
    ],
    "C:\\actual game\\client.jar",
    "C:\\actual game\\natives",
  );
  assert.deepEqual(args, [
    "-Dkeep=yes",
    "-cp",
    "C:\\actual game\\client.jar",
    "-Djava.library.path=C:\\actual game\\natives",
  ]);
  assert.deepEqual(prepareJvmArguments(["-Dkeep=yes"], "cp", "natives"), [
    "-Dkeep=yes",
    "-cp",
    "cp",
    "-Djava.library.path=natives",
  ]);
  assert.throws(
    () => expandArguments(["${unavailable}"], {}),
    /缺少变量.*unavailable/,
  );
});

test("native classifiers use target OS/bitness and extraction exclusions", () => {
  const library = {
    natives: { windows: "natives-windows-${arch}", linux: "natives-linux" },
  };
  assert.equal(
    nativeClassifier(library, "win32", "ia32"),
    "natives-windows-32",
  );
  assert.equal(nativeClassifier(library, "win32", "x64"), "natives-windows-64");
  assert.equal(nativeClassifier(library, "linux", "x64"), "natives-linux");
  assert.equal(nativeExtractionAllowed("META-INF/MANIFEST.MF"), false);
  assert.equal(
    nativeExtractionAllowed("private\\readme.txt", ["private/"]),
    false,
  );
  assert.equal(nativeExtractionAllowed("lwjgl.dll", ["private/"]), true);
});

test("legacy native library without classifier metadata gets a Maven download without fictitious base JAR", () => {
  const root = path.join(os.tmpdir(), "game");
  const service = new GameService(root, () => {}, { minecraftRoot: root });
  const files = service.libraryItems({
    libraries: [
      {
        name: "org.lwjgl.lwjgl:lwjgl-platform:2.9.4",
        url: "https://example.invalid/maven/",
        natives: {
          windows: "natives-windows",
          linux: "natives-linux",
          osx: "natives-osx",
        },
        extract: { exclude: ["META-INF/", "private/"] },
      },
    ],
  });
  assert.equal(files.downloads.length, 1);
  assert.equal(files.classpath.length, 0);
  const classifier = nativeClassifier({
    natives: {
      windows: "natives-windows",
      linux: "natives-linux",
      osx: "natives-osx",
    },
  });
  assert(
    files.downloads[0].url.endsWith(`lwjgl-platform-2.9.4-${classifier}.jar`),
  );
  assert.deepEqual(files.natives[0].excludes, ["META-INF/", "private/"]);
});

async function nativeFixture(t, corrupt = false) {
  const root = await temporary(t);
  const id = "Native Test";
  const game = path.join(root, "versions", id);
  await write(path.join(game, `${id}.jar`), "client");
  await write(path.join(game, ".ldfcl", "natives", "stale.dll"), "old-dll");
  const archive = path.join(root, "libraries", "native.jar");
  if (corrupt) await write(archive, "not a zip");
  else {
    const zip = new AdmZip();
    zip.addFile("current.dll", Buffer.from("new-dll"));
    zip.addFile("private/readme.txt", Buffer.from("exclude"));
    zip.addFile("META-INF/MANIFEST.MF", Buffer.from("exclude"));
    await write(archive, zip.toBuffer());
  }
  const metadata = {
    id,
    _clientId: id,
    libraries: [
      {
        name: "test:natives:1",
        natives: { windows: "native", linux: "native", osx: "native" },
        downloads: {
          classifiers: {
            native: {
              path: "native.jar",
              url: "https://example.invalid/native.jar",
            },
          },
        },
        extract: { exclude: ["private/"] },
      },
    ],
  };
  const service = new GameService(root, () => {}, { minecraftRoot: root });
  service.downloads.downloadMany = async () => {};
  return { root, game, metadata, service };
}

test("native preparation replaces stale DLLs only after full successful extraction", async (t) => {
  const { game, metadata, service } = await nativeFixture(t);
  const result = await service.prepare(metadata, game);
  assert.equal(
    await fs.readFile(path.join(result.natives, "current.dll"), "utf8"),
    "new-dll",
  );
  for (const relative of ["stale.dll", "private", "META-INF"])
    await assert.rejects(fs.access(path.join(result.natives, relative)));
  assert.deepEqual(await fs.readdir(path.join(game, ".ldfcl")), ["natives"]);
});

test("native extraction failure preserves the previously prepared native directory", async (t) => {
  const { game, metadata, service } = await nativeFixture(t, true);
  await assert.rejects(service.prepare(metadata, game));
  assert.equal(
    await fs.readFile(
      path.join(game, ".ldfcl", "natives", "stale.dll"),
      "utf8",
    ),
    "old-dll",
  );
  assert.deepEqual(await fs.readdir(path.join(game, ".ldfcl")), ["natives"]);
});

test("launch uses prepared JVM arguments while preserving selected instance cwd and memory", async (t) => {
  const root = await temporary(t);
  const id = "JVM 参数测试";
  const game = path.join(root, "versions", id);
  await write(
    path.join(game, `${id}.json`),
    JSON.stringify({
      id,
      mainClass: "net.minecraft.client.main.Main",
      libraries: [],
      arguments: {
        jvm: [
          "-Dkeep=yes",
          "-Xmx32M",
          "-classpath",
          "outside.jar",
          "-cp",
          "duplicate.jar",
          "-Djava.library.path=outside",
        ],
        game: ["--gameDir", "${game_directory}"],
      },
    }),
  );
  await write(path.join(game, `${id}.jar`), "client");
  const service = new GameService(root, () => {}, { minecraftRoot: root });
  service.java.ensure = async () => "fixture-java.exe";
  let invocation, child;
  t.mock.method(
    require("node:child_process"),
    "spawn",
    (file, args, options) => {
      invocation = { file, args, options };
      child = new EventEmitter();
      captureJavaStdin(child, invocation);
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 54321;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  );
  await service.launch(
    {
      id: "test",
      version: "1.21.1",
      loader: "vanilla",
      versionDirectory: id,
      gameSettings: {},
    },
    { type: "offline", name: "Alex", uuid: "0123456789abcdef0123456789abcdef" },
    { downloadConcurrency: 2, memoryMode: "manual", memoryMb: 1024 },
  );
  const launchedArguments = decodedJavaInvocation(invocation);
  assert.equal(await fs.realpath(invocation.options.cwd), await fs.realpath(game));
  assert.equal(invocation.args.filter((value) => value === "-cp").length, 1);
  assert.equal(
    await fs.realpath(launchedArguments.classpath),
    await fs.realpath(path.join(game, `${id}.jar`)),
  );
  assert(invocation.args.includes("-Xmx1024M"));
  assert(!invocation.args.includes("-Xmx32M"));
  assert.equal(
    await fs.realpath(invocation.args.find((argument) => argument.startsWith("-Djava.library.path=")).slice("-Djava.library.path=".length)),
    await fs.realpath(path.join(game, ".ldfcl", "natives")),
  );
  child.emit("close", 0);
});
