#!/usr/bin/env node
"use strict";

// Real Windows JVM regression for #6. Everything lives in a new TEMP fixture;
// no account/configuration/game directory is opened. Requires a maintainer JDK
// to compile a Java 8-compatible probe, but never compiles at launcher runtime.
const fs = require("node:fs/promises");
const nativeFs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const AdmZip = require("adm-zip");
const { prepareJavaLaunch } = require("../core/dist/core/services/java-launch.js");
const { GameService } = require("../core/dist/core/services/game.js");

const source = `import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.Base64;
public class UnicodeLaunchProbe {
  static void out(String key, String value) { System.out.println(key+"="+Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8))); }
  public static void main(String[] args) throws Exception {
    out("version",System.getProperty("java.version"));
    out("nativeEncoding",System.getProperty("sun.jnu.encoding", ""));
    out("classpath",System.getProperty("java.class.path"));
    out("nativePath",System.getProperty("java.library.path"));
    out("property",System.getProperty("ldfcl.probe", ""));
    out("agent",System.getProperty("ldfcl.probe.agent", ""));
    out("legacyClasspath",System.getProperty("legacyClassPath", ""));
    out("systemLoader",String.valueOf(UnicodeLaunchProbe.class.getClassLoader()==ClassLoader.getSystemClassLoader()));
    out("dependency",String.valueOf(Class.forName("UnicodeLaunchDependency").getClassLoader()==ClassLoader.getSystemClassLoader()));
    for (String argument:args) out("arg", argument);
    if (System.getProperty("os.name").startsWith("Windows")) System.loadLibrary("ldfcl_probe");
    Path game=Paths.get(args[0]);
    Files.write(game.resolve("launch-result.txt"), args[1].getBytes(StandardCharsets.UTF_8));
    out("written",new String(Files.readAllBytes(game.resolve("launch-result.txt")),StandardCharsets.UTF_8));
  }
}
class UnicodeLaunchDependency {}
class UnicodeLaunchAgent {
  public static void premain(String value, java.lang.instrument.Instrumentation ignored) { System.setProperty("ldfcl.probe.agent",value); }
}`;
const gameServiceSource = `import java.nio.file.*; import java.nio.charset.StandardCharsets;
public class GameServiceLaunchProbe {
  public static void main(String[] args) throws Exception {
    System.out.println("No mods found: continuing with a healthy empty instance");
    Files.write(Paths.get(args[0],"service-result.txt"),args[1].getBytes(StandardCharsets.UTF_8));
    System.out.println("LDFCL_GAME_SERVICE_PROBE_OK");
  }
}`;

function options() {
  const values = { java: [], javac: undefined, report: path.resolve(__dirname, "..", "test-results", "java-unicode-smoke.json") };
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1];
    if (!value || !["--java", "--javac", "--report"].includes(key)) throw Error("Usage: node tests/java-unicode-smoke.cjs [--java java.exe] [--javac javac.exe] [--report absolute.json]");
    if (key === "--java") values.java.push(value);
    else values[key.slice(2)] = value;
  }
  if (!values.java.length && process.platform === "win32") {
    const folder = path.join(process.env.ProgramFiles || "C:\\Program Files", "Java");
    for (const name of nativeFs.readdirSync(folder)) {
      const java = path.join(folder, name, "bin", "java.exe");
      if (nativeFs.existsSync(java) && !/latest/i.test(name)) values.java.push(java);
    }
  }
  if (!values.java.length) values.java.push("java");
  values.javac ||= values.java.map((java) => path.join(path.dirname(java), process.platform === "win32" ? "javac.exe" : "javac")).find((javac) => nativeFs.existsSync(javac)) || "javac";
  return values;
}

function execute(java, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(java, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    const timer = setTimeout(() => { child.kill(); reject(Error("JVM probe timed out")); }, 20000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
    child.stdin.end(input);
  });
}

function decode(stdout) {
  const result = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\w+)=(.*)$/.exec(line);
    if (!match) continue;
    const value = Buffer.from(match[2], "base64").toString("utf8");
    if (match[1] === "arg") (result.arg ||= []).push(value);
    else result[match[1]] = value;
  }
  return result;
}

async function main() {
  const settings = options();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-unicode-smoke-"));
  const report = { check: "real-jvm-unicode-native-agent-long-classpath", startedAt: new Date().toISOString(), root, passed: false, runtimes: [] };
  try {
    const compiled = path.join(root, "compiled");
    await fs.mkdir(compiled);
    const javaSource = path.join(root, "UnicodeLaunchProbe.java");
    const serviceSource = path.join(root, "GameServiceLaunchProbe.java");
    await fs.writeFile(javaSource, source);
    await fs.writeFile(serviceSource, gameServiceSource);
    const build = spawnSync(settings.javac, ["--release", "8", "-g:none", "-encoding", "UTF-8", "-d", compiled, javaSource, serviceSource], { encoding: "utf8", windowsHide: true });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const mainJar = new AdmZip();
    mainJar.addFile("UnicodeLaunchProbe.class", await fs.readFile(path.join(compiled, "UnicodeLaunchProbe.class")));
    const dependencyJar = new AdmZip();
    dependencyJar.addFile("UnicodeLaunchDependency.class", await fs.readFile(path.join(compiled, "UnicodeLaunchDependency.class")));
    const agentJar = new AdmZip();
    agentJar.addFile("META-INF/MANIFEST.MF", Buffer.from("Manifest-Version: 1.0\r\nPremain-Class: UnicodeLaunchAgent\r\n\r\n"));
    agentJar.addFile("UnicodeLaunchAgent.class", await fs.readFile(path.join(compiled, "UnicodeLaunchAgent.class")));
    for (const java of settings.java) {
      const runtime = { java, scenarios: [], gameService: [] };
      report.runtimes.push(runtime);
      for (const scenario of ["ascii", "unicode", "long-classpath"]) {
        const gameRoot = path.join(root, `${runtime === report.runtimes[0] ? "first" : report.runtimes.length}-${scenario}${scenario === "ascii" ? "" : "-中文 # 😄"}`);
        const game = path.join(gameRoot, "versions", "fixture");
        const natives = path.join(game, ".ldfcl", "natives");
        const data = path.join(gameRoot, "launcher-data");
        await fs.mkdir(natives, { recursive: true });
        await fs.mkdir(data);
        const client = path.join(game, "client.jar");
        await fs.writeFile(client, mainJar.toBuffer());
        const library = path.join(gameRoot, "dependency-资源😄.jar");
        await fs.writeFile(library, dependencyJar.toBuffer());
        const agent = path.join(data, "agent.jar");
        await fs.writeFile(agent, agentJar.toBuffer());
        if (process.platform === "win32") await fs.copyFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "version.dll"), path.join(natives, "ldfcl_probe.dll"));
        const classpath = [client, library];
        if (scenario === "long-classpath") {
          const libraries = path.join(gameRoot, "libraries");
          await fs.mkdir(libraries);
          for (let index = 0; index < 360; index++) {
            const file = path.join(libraries, `dependency-${String(index).padStart(4, "0")}-${"x".repeat(40)}.jar`);
            await fs.link(library, file);
            classpath.push(file);
          }
          assert(classpath.join(path.delimiter).length > 32767);
        }
        const message = "Minecraft 用户😄 supplementary 𠀀 # \"quoted\" \\ trailing\\";
        const token = `synthetic-token-${randomUUID()}`;
        const jvmArguments = ["-Dfile.encoding=UTF-8", `-Djava.library.path=${natives}`, `-Dldfcl.probe=${message}`, `-DlegacyClassPath=${classpath.join(path.delimiter)}`, `-javaagent:${agent}=probe-agent`, "-cp", classpath.join(path.delimiter)];
        if (scenario === "unicode") {
          const original = await execute(java, [...jvmArguments, "UnicodeLaunchProbe", game, message, token], game);
          runtime.originalUnicodeLaunch = { code: original.code, stderr: original.stderr.slice(-2000), ...(original.code === 0 ? { output: decode(original.stdout) } : {}) };
        }
        const invocation = await prepareJavaLaunch({ executable: java, jvmArguments, mainClass: "UnicodeLaunchProbe", gameArguments: [game, message, token], classpath, cwd: game, roots: [gameRoot, data] });
        assert(invocation.directory, "Unicode property requires the UTF-8 bootstrap even for an ASCII fixture");
        try {
          const entries = await fs.readdir(invocation.directory, { withFileTypes: true });
          assert.deepEqual(entries.filter((entry) => entry.isFile()).map((entry) => entry.name), ["bootstrap.jar"]);
          const bytes = await fs.readFile(path.join(invocation.directory, "bootstrap.jar"));
          assert(!bytes.includes(Buffer.from(token)), "Token must never be saved in the helper JAR");
          assert(!invocation.args.join(" ").includes(token));
          assert(!invocation.args.join(" ").includes(message));
          const result = await execute(invocation.executable, invocation.args, invocation.cwd, invocation.stdin);
          assert.equal(result.code, 0, `${java} ${scenario}: ${result.stderr}`);
          const values = decode(result.stdout);
          assert.equal(values.arg[1], message);
          assert.equal(values.arg[2], token);
          assert.equal(values.property, message);
          assert.equal(values.agent, "probe-agent");
          assert.equal(values.systemLoader, "true");
          assert.equal(values.dependency, "true");
          assert.equal(values.written, message);
          assert.equal(values.classpath.split(path.delimiter).length, classpath.length);
          assert.equal(values.legacyClasspath, values.classpath);
          assert.equal(await fs.readFile(path.join(game, "launch-result.txt"), "utf8"), message);
          runtime.scenarios.push({ scenario, passed: true, version: values.version, nativeEncoding: values.nativeEncoding, classpathEntries: classpath.length, originalClasspathCharacters: classpath.join(path.delimiter).length, commandCharacters: invocation.args.join(" ").length, argumentUtf8: true, systemClassLoader: true, javaAgent: true, nativeLibrary: process.platform === "win32", gameFileWrittenThroughAlias: true, credentialsOnlyInPipe: true });
        } finally {
          await invocation.dispose();
          await invocation.dispose();
          assert.equal(nativeFs.existsSync(invocation.directory), false, "Temporary aliases must be removed after process exit");
          assert.equal(await fs.readFile(path.join(game, "launch-result.txt"), "utf8"), message, "Junction cleanup must preserve actual game files");
        }
      }
      // Exercise the actual launch service and child lifecycle as well as the
      // low-level bridge. Synthetic local profiles do not download Minecraft,
      // Fabric, assets or accounts and must never be reported as gameplay tests.
      const serviceJar = new AdmZip();
      serviceJar.addFile("GameServiceLaunchProbe.class", await fs.readFile(path.join(compiled, "GameServiceLaunchProbe.class")));
      for (const unicode of [false, true]) for (const loader of ["vanilla", "fabric"]) for (const emptyMods of [false, true]) {
        const id = `service-${unicode ? "unicode" : "ascii"}-${loader}-${emptyMods ? "empty-mods" : "no-mods"}`;
        const gameRoot = path.join(root, `${report.runtimes.length}-${id}${unicode ? "-中文 # 😄" : ""}`);
        const game = path.join(gameRoot, "versions", id);
        await fs.mkdir(game, { recursive: true });
        if (emptyMods) await fs.mkdir(path.join(game, "mods"));
        await fs.writeFile(path.join(game, `${id}.jar`), serviceJar.toBuffer());
        await fs.writeFile(path.join(game, `${id}.json`), JSON.stringify({ id, mainClass: "GameServiceLaunchProbe", libraries: [], arguments: { jvm: [], game: ["${game_directory}", "${auth_player_name}"] } }));
        const events = [];
        let resolveExit;
        const exited = new Promise((resolve) => { resolveExit = resolve; });
        const service = new GameService(path.join(gameRoot, "data"), (event) => { events.push(event); if (event.type === "game" && event.status === "exited") resolveExit(event); }, { minecraftRoot: gameRoot });
        service.java.ensure = async () => java;
        const originalFetch = globalThis.fetch;
        let networkRequests = 0;
        globalThis.fetch = async () => { networkRequests++; throw Error("Network forbidden in the local JVM fixture"); };
        try {
          const name = "ProbeUser";
          const launched = await service.launch({ id, name: id, version: "1.16.5", loader, importedVersionId: id, versionDirectory: id, gameSettings: {} }, { id: "probe", type: "offline", name, uuid: "0123456789abcdef0123456789abcdef" }, { downloadConcurrency: 2, memoryMode: "manual", memoryMb: 512 });
          assert(launched.pid > 0);
          let timer;
          const exit = await Promise.race([exited, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error("GameService JVM fixture timed out")), 20000); })]).finally(() => clearTimeout(timer));
          assert.equal(exit.exitCode, 0, events.filter((event) => event.type === "log").map((event) => event.line).join("\n"));
          assert(!events.some((event) => event.type === "game" && event.status === "error"));
          assert(events.some((event) => event.type === "log" && event.line.includes("LDFCL_GAME_SERVICE_PROBE_OK")));
          assert.equal(await fs.readFile(path.join(game, "service-result.txt"), "utf8"), name);
          assert.equal(service.running.size, 0);
          assert.equal(networkRequests, 0);
          runtime.gameService.push({ unicode, loaderMetadata: loader, emptyMods, passed: true, realJvm: true, networkRequests, exitCode: exit.exitCode });
        } finally { globalThis.fetch = originalFetch; }
      }
    }
    report.passed = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(settings.report), { recursive: true });
    await fs.writeFile(settings.report, JSON.stringify(report, null, 2) + "\n");
    // All invocation junctions have already been unlinked above. This fixture
    // contains only generated probe files, never a user game/data directory.
    if (report.passed) await fs.rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ passed: report.passed, report: settings.report, runtimes: report.runtimes.map((runtime) => ({ java: runtime.java, originalUnicodeExit: runtime.originalUnicodeLaunch?.code, scenarios: runtime.scenarios, gameServicePassed: runtime.gameService.length })) }, null, 2));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
