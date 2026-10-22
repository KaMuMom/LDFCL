#!/usr/bin/env node
"use strict";

// Run only against a finished source archive. Extraction, npm install and build
// happen in a new TEMP checkout; the user's checkout outputs are never touched.
const fs = require("node:fs/promises");
const nativeFs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const AdmZip = require("adm-zip");

const workspace = path.resolve(__dirname, "..");
const usage =
  "Usage: node scripts/verify-source-archive.cjs <absolute-source.zip> [absolute-report.json]";
if (process.argv[3] !== undefined && !path.isAbsolute(process.argv[3]))
  throw Error(usage);
const reportFile =
  process.argv[3] ||
  path.join(workspace, "test-results", "p0-p6-source-rebuild.json");
const ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.electron.json",
  "vite.config.ts",
  "index.html",
  ".gitignore",
  "license",
  "readme.md",
  "validation.md",
  "third_party_notices.md",
  "credits.md",
]);
const SOURCE_DIRECTORIES = new Set([
  "core",
  "electron",
  "cli",
  "bin",
  "scripts",
  "shared",
  "src",
  "public",
  "build",
  "tests",
  "docs",
]);
const FORBIDDEN_PARTS =
  /^(?:node_modules|dist|dist-electron|release|test-results|\.git|\.cache|\.minecraft|ldfcl-data|\.ldfcl|runtime|logs)$/i;
const FORBIDDEN_FILES =
  /^(?:accounts|launcher|launcher_accounts(?:_microsoft_store)?|launcher_profiles|ai-settings|ai-secrets|credentials?|tokens)\.(?:json|xml|dat)$|^\.env(?:\.|$)|^\.npmrc$|^id_(?:rsa|ed25519)(?:\.|$)|\.(?:pem|pfx|p12|key|exe|dll|msi|asar|jar|class|zip|7z)$/i;
const report = {
  schemaVersion: 1,
  check: "p0-p6-independent-source-rebuild",
  startedAt: new Date().toISOString(),
  passed: false,
  workspace,
  archive: undefined,
  temporaryRoot: undefined,
  sourceDirectory: undefined,
  archiveAudit: undefined,
  toolchain: { node: process.execPath, nodeVersion: process.version },
  commands: [],
  dependencies: [],
  links: [],
  outputs: [],
};

function contained(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return (
    !relative ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
function assert(condition, message) {
  if (!condition) throw Error(message);
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const bytes of nativeFs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
function archivePath(name) {
  assert(
    typeof name === "string" &&
      name.length > 0 &&
      name.length < 2048 &&
      !/[\\\x00-\x1f<>:"|?*]/.test(name) &&
      !path.isAbsolute(name),
    "Archive contains an unsafe path",
  );
  const value = name.endsWith("/") ? name.slice(0, -1) : name;
  for (const part of value.split("/"))
    assert(
      part &&
        part !== "." &&
        part !== ".." &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      "Archive path contains a forbidden segment",
    );
  return value;
}
function auditArchive(archive) {
  const entries = archive.getEntries(),
    names = new Map();
  assert(
    entries.length > 0 && entries.length < 20000,
    "Unexpected source archive entry count",
  );
  let expandedBytes = 0,
    files = 0;
  for (const entry of entries) {
    const relative = archivePath(entry.entryName),
      lower = relative.toLowerCase(),
      parts = relative.split("/");
    assert(!names.has(lower), "Archive contains duplicate/case-aliased paths");
    names.set(lower, entry.isDirectory ? "directory" : "file");
    assert(
      !parts.some((part) => FORBIDDEN_PARTS.test(part)),
      `Private data, dependencies or build output in archive: ${relative}`,
    );
    assert(
      !FORBIDDEN_FILES.test(parts[parts.length - 1]),
      `Private/binary file in source archive: ${relative}`,
    );
    assert(
      SOURCE_DIRECTORIES.has(parts[0].toLowerCase()) ||
        (parts.length === 1 && ROOT_FILES.has(lower)),
      `Source archive entry is outside the source allowlist: ${relative}`,
    );
    const unixMode =
      (Number(entry.attr ?? entry.header.attr) >>> 16) & 0o170000;
    assert(
      unixMode !== 0o120000,
      `Source archive contains a symbolic link: ${relative}`,
    );
    assert(
      !(entry.header.flags & 1),
      "Encrypted source archive entries are unsupported",
    );
    assert(
      Number.isSafeInteger(entry.header.size) &&
        entry.header.size >= 0 &&
        entry.header.size <= 128 * 1024 * 1024,
      "Source archive file exceeds size limit",
    );
    expandedBytes += entry.header.size;
    assert(
      expandedBytes <= 512 * 1024 * 1024,
      "Source archive expanded size exceeds limit",
    );
    if (!entry.isDirectory) files++;
  }
  for (const key of names.keys()) {
    const parents = key.split("/");
    parents.pop();
    while (parents.length) {
      assert(
        names.get(parents.join("/")) !== "file",
        "Archive file/directory path conflict",
      );
      parents.pop();
    }
  }
  for (const required of [
    "package.json",
    "package-lock.json",
    "core/package.json",
    "core/tsconfig.json",
    "core/index.ts",
    "core/launcher.ts",
    "core/services/content-store.ts",
    "core/services/instance-manifest.ts",
    "core/services/snapshots.ts",
    "core/services/health.ts",
    "core/services/crash-diagnostics.ts",
    "core/services/ai.ts",
    "cli/main.ts",
    "cli/commands.ts",
    "bin/ldfcl-cli.cjs",
    "electron/main.ts",
    "src/app.tsx",
    "scripts/clean-main.cjs",
    "shared/types.ts",
  ])
    assert(
      names.get(required) === "file",
      `Required source is absent: ${required}`,
    );
  return {
    entries,
    summary: {
      entries: entries.length,
      files,
      expandedBytes,
      privatePathsAbsent: true,
      dependenciesAbsent: true,
      buildOutputsAbsent: true,
      sourceAllowlistOnly: true,
      symbolicLinksAbsent: true,
    },
  };
}
async function extract(entries, destination) {
  await fs.mkdir(destination);
  for (const entry of entries) {
    const relative = archivePath(entry.entryName),
      output = path.resolve(destination, ...relative.split("/"));
    assert(
      contained(destination, output),
      "Extraction target escapes temporary checkout",
    );
    if (entry.isDirectory) await fs.mkdir(output, { recursive: true });
    else {
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, entry.getData(), { flag: "wx" });
    }
  }
  assert(
    !(await fs.stat(path.join(destination, "node_modules")).then(
      () => true,
      () => false,
    )),
    "Fresh extraction unexpectedly has node_modules",
  );
}
async function npmCliPath() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  candidates.push(
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  );
  const located = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["npm"],
    { encoding: "utf8", windowsHide: true },
  );
  if (located.status === 0)
    for (const line of located.stdout.split(/\r?\n/).filter(Boolean)) {
      const resolved = await fs.realpath(line.trim()).catch(() => line.trim());
      if (/npm-cli\.(?:c?js)$/i.test(resolved)) candidates.push(resolved);
      candidates.push(
        path.join(
          path.dirname(resolved),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      );
      candidates.push(
        path.resolve(
          path.dirname(resolved),
          "..",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      );
    }
  for (const candidate of candidates)
    if (
      /npm-cli\.(?:c?js)$/i.test(candidate) &&
      (await fs.stat(candidate).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      return fs.realpath(candidate);
  throw Error("Cannot locate npm-cli.js for direct Node execution");
}
function cleanEnvironment(sourceDirectory) {
  const env = { ...process.env };
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const paths = String(env[pathKey] || "")
    .split(path.delimiter)
    .filter((value) => value && !contained(workspace, value));
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (
      [
        "node_options",
        "node_path",
        "electron_run_as_node",
        "npm_config_local_prefix",
        "npm_config_workspace",
        "npm_config_workspaces",
        "npm_config_global",
        "npm_config_prefix",
        "init_cwd",
      ].includes(lower) ||
      lower === "path"
    )
      delete env[key];
  }
  env.PATH = [path.dirname(process.execPath), ...paths].join(path.delimiter);
  env.INIT_CWD = sourceDirectory;
  // Never inspect or log the rest of the environment. npm's existing shared
  // cache is intentional; module and binary lookups may only use this checkout.
  return env;
}
async function run(label, executable, args, cwd, env, temporaryRoot) {
  const stdoutLog = path.join(temporaryRoot, `${label}.stdout.log`),
    stderrLog = path.join(temporaryRoot, `${label}.stderr.log`);
  const start = Date.now(),
    command = {
      label,
      executable,
      args,
      cwd,
      stdoutLog,
      stderrLog,
      startedAt: new Date().toISOString(),
    };
  report.commands.push(command);
  console.log(`${label}: ${args.join(" ")} (logs: ${temporaryRoot})`);
  const output = nativeFs.createWriteStream(stdoutLog),
    errors = nativeFs.createWriteStream(stderrLog);
  let stdout = "";
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(output);
    child.stderr.pipe(errors);
    child.stdout.on("data", (bytes) => {
      if (stdout.length < 1024 * 1024) stdout += bytes.toString();
    });
    const timer = setTimeout(
      () => {
        command.timedOut = true;
        if (process.platform === "win32" && child.pid)
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        else child.kill("SIGTERM");
      },
      10 * 60 * 1000,
    );
    child.on("error", (error) => {
      clearTimeout(timer);
      output.end();
      errors.end();
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      command.exitCode = code;
      command.signal = signal;
      command.durationMs = Date.now() - start;
      await Promise.all([
        new Promise((done) => output.end(done)),
        new Promise((done) => errors.end(done)),
      ]);
      if (code !== 0 || command.timedOut)
        reject(
          Error(
            `${label} failed (${command.timedOut ? "timeout" : `exit ${code}`}); see ${stderrLog}`,
          ),
        );
      else resolve();
    });
  });
  return stdout;
}
async function auditLocalPackageSources(sourceDirectory) {
  const lock = JSON.parse(
    await fs.readFile(path.join(sourceDirectory, "package-lock.json"), "utf8"),
  );
  for (const entry of Object.values(lock.packages || {})) {
    if (typeof entry?.resolved !== "string") continue;
    if (/^https?:/i.test(entry.resolved)) {
      const url = new URL(entry.resolved);
      assert(
        !url.username && !url.password,
        "Lockfile contains URL credentials",
      );
    } else if (entry.link || /^file:/i.test(entry.resolved)) {
      const local = entry.resolved.replace(/^file:/i, "");
      assert(
        !path.isAbsolute(local) &&
          !/^[a-z]:/i.test(local) &&
          contained(sourceDirectory, path.resolve(sourceDirectory, local)),
        "Lockfile has an external local dependency",
      );
    }
  }
}
async function dependencyProof(sourceDirectory) {
  const rootManifest = JSON.parse(
    await fs.readFile(path.join(sourceDirectory, "package.json"), "utf8"),
  );
  const coreManifest = JSON.parse(
    await fs.readFile(
      path.join(sourceDirectory, "core", "package.json"),
      "utf8",
    ),
  );
  for (const name of Object.keys({
    ...rootManifest.dependencies,
    ...rootManifest.devDependencies,
  })) {
    const packageFile = path.join(
        sourceDirectory,
        "node_modules",
        ...name.split("/"),
        "package.json",
      ),
      real = await fs.realpath(packageFile);
    assert(
      contained(sourceDirectory, real) && !contained(workspace, real),
      `Dependency escaped independent checkout: ${name}`,
    );
    const installed = JSON.parse(await fs.readFile(real, "utf8"));
    report.dependencies.push({
      name,
      version: installed.version,
      manifestRealPath: real,
    });
  }
  const coreLink = await fs.realpath(
    path.join(sourceDirectory, "node_modules", "@ldfcl", "core"),
  );
  assert(
    coreLink === (await fs.realpath(path.join(sourceDirectory, "core"))),
    "Workspace core link does not point into independent checkout",
  );
  const coreRequire = createRequire(
    path.join(sourceDirectory, "core", "package.json"),
  );
  for (const name of Object.keys(coreManifest.dependencies || {})) {
    const real = await fs.realpath(coreRequire.resolve(name));
    assert(
      contained(sourceDirectory, real),
      `Core dependency escaped independent checkout: ${name}`,
    );
  }
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name),
        stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        const real = await fs.realpath(file);
        assert(
          contained(sourceDirectory, real),
          "Installed dependency link points outside independent checkout",
        );
        report.links.push({ path: file, realPath: real });
      } else if (stat.isDirectory()) await inspect(file);
    }
  }
  await inspect(path.join(sourceDirectory, "node_modules"));
  report.workspaceCoreRealPath = coreLink;
}
async function verifyOutputs(sourceDirectory) {
  for (const relative of [
    "dist/index.html",
    "dist-electron/electron/main.js",
    "dist-electron/cli/main.js",
    "dist-electron/cli/commands.js",
    "core/dist/core/index.js",
    "core/dist/core/index.d.ts",
    "core/dist/core/launcher.js",
    "core/dist/core/services/content-store.js",
    "core/dist/core/services/instance-manifest.js",
    "core/dist/core/services/snapshots.js",
    "core/dist/core/services/health.js",
    "core/dist/core/services/crash-diagnostics.js",
    "core/dist/core/services/ai.js",
  ]) {
    const file = path.join(sourceDirectory, ...relative.split("/")),
      real = await fs.realpath(file),
      stat = await fs.stat(real);
    assert(
      stat.isFile() && stat.size > 0 && contained(sourceDirectory, real),
      `Missing or external build output: ${relative}`,
    );
    report.outputs.push({
      path: relative,
      size: stat.size,
      sha256: await hashFile(real),
    });
  }
}
async function main() {
  const argument = process.argv[2];
  assert(
    (process.argv.length === 3 || process.argv.length === 4) &&
      argument &&
      path.isAbsolute(argument),
    usage,
  );
  const stat = await fs.lstat(argument);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && /\.zip$/i.test(argument),
    "Source archive must be an ordinary ZIP file",
  );
  assert(
    stat.size > 0 && stat.size < 256 * 1024 * 1024,
    "Source archive size is invalid",
  );
  report.archive = {
    path: await fs.realpath(argument),
    size: stat.size,
    sha256: await hashFile(argument),
  };
  const archive = new AdmZip(argument),
    audit = auditArchive(archive);
  report.archiveAudit = audit.summary;
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "LDFCL-P0-P6-source-rebuild-"),
  );
  const sourceDirectory = path.join(temporaryRoot, "clean-source");
  report.temporaryRoot = temporaryRoot;
  report.sourceDirectory = sourceDirectory;
  assert(
    !contained(workspace, sourceDirectory),
    "Temporary build checkout is inside original workspace",
  );
  await extract(audit.entries, sourceDirectory);
  await auditLocalPackageSources(sourceDirectory);
  const npmCli = await npmCliPath();
  report.toolchain.npmCli = npmCli;
  const env = cleanEnvironment(sourceDirectory);
  await run(
    "npm-ci",
    process.execPath,
    [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"],
    sourceDirectory,
    env,
    temporaryRoot,
  );
  await dependencyProof(sourceDirectory);
  await run(
    "npm-build",
    process.execPath,
    [npmCli, "run", "build"],
    sourceDirectory,
    env,
    temporaryRoot,
  );
  await verifyOutputs(sourceDirectory);
  const runtimeProbe = `
    const path=require('node:path'),fs=require('node:fs'),Module=require('node:module');
    const root=fs.realpathSync(process.cwd());
    function inside(file){const rel=path.relative(root,fs.realpathSync(file));return !rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
    const original=Module._resolveFilename;let loaded=0;
    Module._resolveFilename=function(request,...args){
      if(request==='electron'||request.startsWith('electron/'))throw Error('Core attempted Electron import');
      const resolved=original.call(this,request,...args);
      if(path.isAbsolute(resolved)){if(!inside(resolved))throw Error('Module escaped clean checkout');loaded++;}
      return resolved;
    };
    const core=require('@ldfcl/core');
    if(typeof core.createLauncherCore!=='function'||typeof core.InstanceStorageService!=='function'||typeof core.SnapshotService!=='function')throw Error('Core exports incomplete');
    process.stdout.write(JSON.stringify({cwd:root,core:fs.realpathSync(require.resolve('@ldfcl/core')),admZip:fs.realpathSync(require.resolve('adm-zip')),loaded,externalModuleLoads:0,electronLoaded:false}));
  `;
  const proof = await run(
    "runtime-proof",
    process.execPath,
    ["-e", runtimeProbe],
    sourceDirectory,
    env,
    temporaryRoot,
  );
  report.runtimeProof = JSON.parse(proof);
  report.passed = true;
}

main()
  .catch((error) => {
    report.error = error.message;
    process.exitCode = 1;
  })
  .finally(async () => {
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(reportFile), { recursive: true });
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        passed: report.passed,
        reportFile,
        temporaryRoot: report.temporaryRoot,
        error: report.error,
      }),
    );
  });
