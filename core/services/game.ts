import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import AdmZip from "adm-zip";
import type { Instance, Account, Settings } from "../../shared/types";
import { LAUNCHER_VERSION } from "../../shared/launcher";
import {
  GAME_OPTION_DEFAULTS,
  effectiveGameOptions,
} from "../../shared/game-settings";
import { validateExtraJvmArguments } from "../../shared/jvm-arguments";
import { CrashDiagnostics } from "./crash-diagnostics";
import { prepareJavaLaunch } from "./java-launch";
import { readModMetadata } from "./mod-metadata";
import type { DiagnosisMod } from "../../shared/diagnostics";
import { installOptifine, optifineVersions } from "./optifine";
import { neoforgeArtifact, neoforgeVersions } from "./neoforge";
import { safeGameVersionId } from "../game-directories";
import {
  allocateVersionDirectory,
  assertInstanceGameDirectory,
  assertPlainTree,
  instanceGameDirectory,
  instanceVersionDirectoryId,
} from "../instance-paths";
import {
  DownloadManager,
  DownloadItem,
  Emit,
  requestJson,
  fileHash,
  type DownloadPlan,
  type DownloadContext,
} from "./downloads";
import {
  JavaManager,
  automaticMemoryMb,
  safeExtractZip,
  runProcess,
} from "./java";
import {
  nativeClassifier,
  nativeExtractionAllowed,
  prepareJvmArguments,
} from "./launch-preparation";

const MANIFEST =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MAVEN = "https://libraries.minecraft.net/";

export function rulesAllow(
  rules?: any[],
  features: Record<string, boolean> = {},
  platform = process.platform,
  architecture = process.arch,
  release = os.release(),
): boolean {
  if (!rules?.length) return true;
  let allowed = false;
  const osName =
    platform === "win32" ? "windows" : platform === "darwin" ? "osx" : "linux";
  const architectures =
    architecture === "x64"
      ? ["x86_64", "amd64", "x64"]
      : architecture === "ia32"
        ? ["x86", "i386", "ia32"]
        : architecture === "arm64"
          ? ["arm64", "aarch64"]
          : [architecture];
  for (const rule of rules) {
    if (rule.os?.name && rule.os.name !== osName) continue;
    if (rule.os?.arch && !architectures.includes(rule.os.arch)) continue;
    if (rule.os?.version && !new RegExp(rule.os.version).test(release))
      continue;
    if (
      rule.features &&
      Object.entries(rule.features).some(
        ([key, value]) => !!features[key] !== value,
      )
    )
      continue;
    allowed = rule.action === "allow";
  }
  return allowed;
}

export function mavenPath(coordinate: string): string {
  const [identifier, extension = "jar"] = coordinate.split("@");
  const [group, artifact, version, classifier] = identifier.split(":");
  if (
    !group ||
    !artifact ||
    !version ||
    /[\\/]/.test(artifact + version + (classifier || "") + extension) ||
    group.includes("..")
  )
    throw new Error("无效的 Maven 坐标");
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}${classifier ? "-" + classifier : ""}.${extension}`;
}

export function tokenizeArguments(value: string): string[] {
  const result: string[] = [];
  const regex = /(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s"'])+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)))
    result.push(
      match[0].replace(
        /"((?:\\.|[^"\\])*)"|'([^']*)'/g,
        (_quoted, doubleQuoted, singleQuoted) =>
          doubleQuoted !== undefined
            ? doubleQuoted.replace(/\\"/g, '"')
            : singleQuoted,
      ),
    );
  return result;
}

function isolateGameDirectoryArguments(
  args: string[],
  gameDirectory: string,
): string[] {
  const result: string[] = [];
  let replaced = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--gameDir" || argument.startsWith("--gameDir=")) {
      if (
        argument === "--gameDir" &&
        args[index + 1] !== undefined &&
        !args[index + 1].startsWith("--")
      )
        index++;
      if (!replaced) {
        result.push("--gameDir", gameDirectory);
        replaced = true;
      }
    } else result.push(argument);
  }
  return result;
}

export function expandArguments(
  input: any[],
  variables: Record<string, string>,
  features: Record<string, boolean> = {},
): string[] {
  const values = input.flatMap((value) =>
    typeof value === "string"
      ? [value]
      : rulesAllow(value.rules, features)
        ? Array.isArray(value.value)
          ? value.value
          : [value.value]
        : [],
  );
  return values.map((value) =>
    String(value).replace(/\$\{([^}]+)\}/g, (_all, key) => {
      if (!(key in variables)) throw new Error(`启动参数缺少变量：${key}`);
      return variables[key];
    }),
  );
}

function safeId(id: string): string {
  return safeGameVersionId(id);
}
function libraryKey(library: any): string {
  const chunks = String(library.name).split(":");
  return `${chunks[0]}:${chunks[1]}:${chunks[3] || ""}`;
}
function versionJava(version: string): number {
  if (/^(?:2\d\.|26w|27w)/.test(version)) return 25;
  const match = version.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!match) return 21;
  const minor = Number(match[1]),
    patch = Number(match[2] || 0);
  return minor > 20 || (minor === 20 && patch >= 5)
    ? 21
    : minor >= 18
      ? 17
      : minor === 17
        ? 16
        : 8;
}

export class GameService {
  private root: string;
  private downloads: DownloadManager;
  private java: JavaManager;
  private running = new Map<string, ChildProcess>();
  private installing = new Set<string>();
  private starting = new Set<string>();
  private diagnostics: CrashDiagnostics;
  private sessions = new Map<
    string,
    Awaited<ReturnType<CrashDiagnostics["begin"]>>
  >();
  constructor(
    private dataDir: string,
    private emit: Emit = () => {},
    options: { minecraftRoot?: string; diagnostics?: CrashDiagnostics } = {},
  ) {
    if (options.minecraftRoot && !path.isAbsolute(options.minecraftRoot))
      throw new Error("游戏资源目录必须使用完整的绝对路径。");
    this.root = options.minecraftRoot
      ? path.resolve(options.minecraftRoot)
      : path.join(dataDir, "minecraft");
    this.downloads = new DownloadManager(dataDir, emit);
    this.java = new JavaManager(dataDir, emit, this.downloads);
    this.diagnostics =
      options.diagnostics ||
      new CrashDiagnostics(dataDir, {
        onDiagnosis: (diagnosis) => this.emit({ type: "diagnosis", diagnosis }),
      });
  }

  async versions(): Promise<any[]> {
    const manifest = await requestJson<any>(MANIFEST);
    return manifest.versions.map((version: any) => ({
      ...version,
      latest: version.id === manifest.latest.release,
      latestSnapshot: version.id === manifest.latest.snapshot,
    }));
  }

  async optifineVersions(version: string) {
    return optifineVersions(version);
  }
  async neoforgeVersions(version: string) {
    return neoforgeVersions(version);
  }

  setConcurrency(value: number): void {
    this.downloads.concurrency = Math.max(
      1,
      Math.min(32, Math.floor(Number(value) || 8)),
    );
  }

  private async vanilla(version: string): Promise<any> {
    safeId(version);
    const versions = await this.versions();
    const entry = versions.find((item) => item.id === version);
    if (!entry) throw new Error(`未找到 Minecraft ${version}`);
    const file = path.join(
      this.dataDir,
      "cache",
      "version-metadata",
      `${version}.json`,
    );
    await this.downloads.download(entry.url, file, entry.sha1);
    return JSON.parse(await fs.readFile(file, "utf8"));
  }

  private async saveVersion(metadata: any): Promise<void> {
    const id = safeId(metadata.id);
    const directory = path.join(this.root, "versions", id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, `${id}.json`),
      JSON.stringify(metadata, null, 2),
      "utf8",
    );
  }

  private async loaderProfile(
    version: string,
    loader: string,
    requested?: string,
  ): Promise<{ id: string; loaderVersion: string }> {
    if (loader === "optifine") {
      return installOptifine({
        dataDir: this.dataDir,
        minecraftRoot: this.root,
        version,
        requested,
        javaMajor: versionJava(version),
        java: this.java,
        downloads: this.downloads,
        emit: this.emit,
      });
    }
    if (loader === "fabric" || loader === "quilt") {
      const base =
        loader === "fabric"
          ? "https://meta.fabricmc.net/v2"
          : "https://meta.quiltmc.org/v3";
      const loaders = await requestJson<any[]>(
        `${base}/versions/loader/${encodeURIComponent(version)}`,
      );
      const selected = requested
        ? loaders.find((item) => item.loader?.version === requested)
        : loaders.find((item) => item.loader?.stable) || loaders[0];
      if (!selected)
        throw new Error(
          `${loader} 暂不支持 Minecraft ${version}，请选择其他游戏版本`,
        );
      const loaderVersion = selected.loader.version;
      const metadata = await requestJson<any>(
        `${base}/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loaderVersion)}/profile/json`,
      );
      await this.saveVersion(metadata);
      return { id: metadata.id, loaderVersion };
    }
    if (loader === "neoforge") {
      const versions = await neoforgeVersions(version);
      const loaderVersion =
        requested ||
        versions.find((item) => !item.includes("beta")) ||
        versions[0];
      if (!loaderVersion || !versions.includes(loaderVersion))
        throw new Error(`NeoForge 暂无 Minecraft ${version} 对应的指定版本`);
      const artifact = neoforgeArtifact(version);
      const url = `https://maven.neoforged.net/releases/net/neoforged/${artifact}/${loaderVersion}/${artifact}-${loaderVersion}-installer.jar`;
      const checksumResponse = await fetch(`${url}.sha1`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!checksumResponse.ok)
        throw new Error("无法获取官方 NeoForge 安装器校验值");
      const checksum = (await checksumResponse.text()).trim().split(/\s/)[0];
      if (!/^[a-f0-9]{40}$/i.test(checksum))
        throw new Error("NeoForge 安装器校验值无效");
      const installer = path.join(
        this.dataDir,
        "cache",
        `neoforge-${loaderVersion}-installer.jar`,
      );
      await this.downloads.download(
        url,
        installer,
        checksum,
        undefined,
        "下载 NeoForge 安装器",
      );
      const javaPath = await this.java.ensure(versionJava(version));
      await fs.mkdir(this.root, { recursive: true });
      const profiles = path.join(this.root, "launcher_profiles.json");
      await fs
        .writeFile(profiles, '{"profiles":{}}', { flag: "wx" })
        .catch((error: any) => {
          if (error.code !== "EEXIST") throw error;
        });
      const taskId = randomUUID();
      const report = (status: string, detail?: string) =>
        this.emit({
          type: "task",
          task: {
            id: taskId,
            title: "安装 NeoForge",
            progress: status === "completed" ? 1 : 0.1,
            status,
            detail,
          },
        });
      report("running", "运行官方安装器并生成客户端配置");
      try {
        await runProcess(
          javaPath,
          ["-jar", installer, "--installClient", this.root],
          this.root,
          (line) => this.emit({ type: "log", instanceId: "installer", line }),
        );
        const directories = await fs.readdir(path.join(this.root, "versions"));
        for (const directory of directories) {
          safeId(directory);
          if (directory === version) continue;
          const filename = path.join(
            this.root,
            "versions",
            directory,
            `${directory}.json`,
          );
          await assertPlainTree(filename);
          const metadata = JSON.parse(await fs.readFile(filename, "utf8"));
          if (
            metadata.id === directory &&
            metadata.inheritsFrom === version &&
            (directory.includes(loaderVersion) ||
              JSON.stringify(metadata.libraries).includes(`:${loaderVersion}`))
          ) {
            report("completed");
            return { id: directory, loaderVersion };
          }
        }
        throw new Error("NeoForge 官方安装器未生成匹配的客户端配置");
      } catch (error) {
        report("failed", String(error));
        throw error;
      }
    }
    if (loader === "forge") {
      const promotions = await requestJson<any>(
        "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
      );
      const loaderVersion =
        requested ||
        promotions.promos[`${version}-recommended`] ||
        promotions.promos[`${version}-latest`];
      if (!loaderVersion)
        throw new Error(`Forge 暂无 Minecraft ${version} 对应版本`);
      if (!/^[0-9A-Za-z._\-]+$/.test(loaderVersion))
        throw new Error("无效 Forge 版本");
      const coordinate = `${version}-${loaderVersion}`;
      const installer = path.join(
        this.dataDir,
        "cache",
        `forge-${coordinate}-installer.jar`,
      );
      const checksumUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${coordinate}/forge-${coordinate}-installer.jar`;
      const shaResponse = await fetch(`${checksumUrl}.sha1`, {
        signal: AbortSignal.timeout(30000),
      });
      const checksum = shaResponse.ok
        ? (await shaResponse.text()).trim().split(/\s/)[0]
        : undefined;
      await this.downloads.download(
        checksumUrl,
        installer,
        checksum && /^[a-f0-9]{40}$/i.test(checksum) ? checksum : undefined,
        undefined,
        "下载 Forge 安装器",
      );
      const javaPath = await this.java.ensure(versionJava(version));
      await fs.mkdir(this.root, { recursive: true });
      const profiles = path.join(this.root, "launcher_profiles.json");
      try {
        await fs.access(profiles);
      } catch {
        await fs.writeFile(profiles, '{"profiles":{}}', "utf8");
      }
      const taskId = randomUUID();
      this.emit({
        type: "task",
        task: {
          id: taskId,
          title: "安装 Forge",
          progress: 0.1,
          status: "running",
          detail: "正在运行官方安装器",
        },
      });
      try {
        await runProcess(
          javaPath,
          ["-jar", installer, "--installClient", this.root],
          this.root,
          (line) => this.emit({ type: "log", instanceId: "installer", line }),
        );
      } catch (error) {
        this.emit({
          type: "task",
          task: {
            id: taskId,
            title: "安装 Forge",
            status: "failed",
            progress: 0,
            detail: String(error),
          },
        });
        throw error;
      }
      const directories = await fs.readdir(path.join(this.root, "versions"));
      const id = directories.find(
        (item) =>
          item.includes(loaderVersion) &&
          item.toLowerCase().includes("forge") &&
          item.includes(version),
      );
      if (!id)
        throw new Error(
          "Forge 安装器未生成版本文件；此版本可能需要手动选择受支持的 Forge 版本",
        );
      this.emit({
        type: "task",
        task: {
          id: taskId,
          title: "安装 Forge",
          progress: 1,
          status: "completed",
        },
      });
      return { id, loaderVersion };
    }
    throw new Error("不支持的 Mod 加载器");
  }

  private async metadata(id: string, depth = 0): Promise<any> {
    safeId(id);
    if (depth > 8) throw new Error("版本继承层数异常");
    let own: any;
    try {
      const folder = path.join(this.root, "versions", id);
      const folderStat = await fs.lstat(folder);
      const fileStat = await fs.lstat(path.join(folder, `${id}.json`));
      if (
        folderStat.isSymbolicLink() ||
        !folderStat.isDirectory() ||
        fileStat.isSymbolicLink() ||
        !fileStat.isFile()
      )
        throw new Error("版本配置不能使用符号链接或目录联接");
      own = JSON.parse(
        await fs.readFile(
          path.join(this.root, "versions", id, `${id}.json`),
          "utf8",
        ),
      );
      if (own?.id !== id) throw new Error("版本配置标识不符");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      own = await this.vanilla(id);
    }
    if (own._ldfclVanillaSource) {
      const base = await this.vanilla(safeId(own._ldfclVanillaSource));
      return { ...base, ...own, _clientId: own.id, _ownClient: false };
    }
    if (!own.inheritsFrom)
      return {
        ...own,
        _clientId: own.jar || own.id,
        _ownClient: !!own.downloads?.client,
      };
    const parent = await this.metadata(own.inheritsFrom, depth + 1);
    const libraries = new Map<string, any>();
    for (const item of [...(parent.libraries || []), ...(own.libraries || [])])
      libraries.set(libraryKey(item), item);
    return {
      ...parent,
      ...own,
      libraries: [...libraries.values()],
      downloads: { ...parent.downloads, ...own.downloads },
      arguments: {
        game: [
          ...(parent.arguments?.game || []),
          ...(own.arguments?.game || []),
        ],
        jvm: [...(parent.arguments?.jvm || []), ...(own.arguments?.jvm || [])],
      },
      _clientId: own.downloads?.client ? own.id : own.jar || parent._clientId,
      _ownClient: !!own.downloads?.client,
    };
  }

  private libraryItems(metadata: any): {
    downloads: DownloadItem[];
    classpath: string[];
    natives: { path: string; excludes: string[] }[];
  } {
    const downloads: DownloadItem[] = [],
      classpath: string[] = [],
      natives: { path: string; excludes: string[] }[] = [];
    for (const library of metadata.libraries || []) {
      if (!rulesAllow(library.rules)) continue;
      const artifact = library.downloads?.artifact;
      const hasNatives = !!library.natives;
      if (artifact || !hasNatives) {
        const relative = artifact?.path || mavenPath(library.name);
        const target = this.libraryPath(relative);
        const url =
          artifact?.url ||
          `${(library.url || MAVEN).replace(/\/?$/, "/")}${relative}`;
        downloads.push({
          url,
          path: target,
          sha1: artifact?.sha1,
          size: artifact?.size,
        });
        classpath.push(target);
      }
      const classifierName = nativeClassifier(library);
      const classifier =
        classifierName && library.downloads?.classifiers?.[classifierName];
      if (classifierName) {
        const coordinate = String(library.name)
          .split("@")[0]
          .split(":")
          .slice(0, 3)
          .join(":");
        const relative =
          classifier?.path || mavenPath(`${coordinate}:${classifierName}`);
        const target = this.libraryPath(relative);
        downloads.push({
          url:
            classifier?.url ||
            `${(library.url || MAVEN).replace(/\/?$/, "/")}${relative}`,
          path: target,
          sha1: classifier?.sha1,
          size: classifier?.size,
        });
        natives.push({
          path: target,
          excludes: Array.isArray(library.extract?.exclude)
            ? library.extract.exclude.filter(
                (value: unknown): value is string => typeof value === "string",
              )
            : [],
        });
      }
    }
    return { downloads, classpath, natives };
  }

  private libraryPath(relative: string): string {
    const root = path.resolve(this.root, "libraries");
    const full = path.resolve(root, relative);
    if (!full.startsWith(root + path.sep)) throw new Error("游戏库路径越界");
    return full;
  }

  private async prepare(
    metadata: any,
    gameDirectory: string,
    inputPlan?: DownloadPlan,
    context?: DownloadContext,
  ): Promise<{ classpath: string[]; natives: string; assetIndex: any }> {
    const plan =
      inputPlan ||
      this.downloads.createPlan({
        title: `补全 Minecraft ${metadata.minecraftVersion || metadata.id || "游戏"}`,
        context: {
          resourceName: `Minecraft ${metadata.minecraftVersion || metadata.id || ""}`,
          targetInstanceName: path.basename(gameDirectory),
          ...context,
        },
        stages: [
          { id: "libraries", title: "游戏本体与运行库" },
          { id: "natives", title: "解压原生运行库" },
          { id: "assets", title: "音效、贴图与游戏资源" },
          { id: "logging", title: "日志运行配置" },
        ],
      });
    try {
      await plan.ready();
      plan.startStage("libraries");
      await fs.mkdir(gameDirectory, { recursive: true });
      const files = this.libraryItems(metadata);
      const clientId = safeId(path.basename(gameDirectory));
      const clientFile = path.join(
        this.root,
        "versions",
        clientId,
        `${clientId}.jar`,
      );
      const sourceClientId = safeId(metadata._clientId);
      if (sourceClientId !== clientId) {
        const sourceFolder = path.join(this.root, "versions", sourceClientId);
        const sourceFile = path.join(sourceFolder, `${sourceClientId}.jar`);
        try {
          const folderStat = await fs.lstat(sourceFolder);
          const fileStat = await fs.lstat(sourceFile);
          if (
            folderStat.isSymbolicLink() ||
            fileStat.isSymbolicLink() ||
            !fileStat.isFile()
          )
            throw new Error("客户端 JAR 不能使用符号链接或目录联接");
          await fs
            .copyFile(sourceFile, clientFile, 1 /* COPYFILE_EXCL */)
            .catch((error: any) => {
              if (error.code !== "EEXIST") throw error;
            });
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      let existingClient = false;
      try {
        const stat = await fs.lstat(clientFile);
        if (stat.isSymbolicLink() || !stat.isFile())
          throw new Error("客户端 JAR 不是普通文件");
        existingClient = stat.size > 0;
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      // An imported child's own JAR may be customized. Inherited parent hashes
      // describe the parent only and must never replace that supplied client.
      if (
        metadata.downloads?.client?.url &&
        (metadata._ownClient || !existingClient)
      )
        files.downloads.push({
          url: metadata.downloads.client.url,
          path: clientFile,
          sha1: metadata.downloads.client.sha1,
          size: metadata.downloads.client.size,
        });
      else
        await fs.access(clientFile).catch(() => {
          throw new Error("版本未提供客户端 JAR");
        });
      await this.downloads.downloadMany(
        files.downloads,
        "补全游戏与依赖库",
        plan.context("libraries"),
      );
      plan.completeStage("libraries");
      await plan.ready();
      plan.startStage("natives");
      const nativesDirectory = path.join(gameDirectory, ".ldfcl", "natives");
      const nativesStage = path.join(
        gameDirectory,
        ".ldfcl",
        `natives-new-${randomUUID()}`,
      );
      const nativesBackup = path.join(
        gameDirectory,
        ".ldfcl",
        `natives-old-${randomUUID()}`,
      );
      await fs.mkdir(nativesStage, { recursive: true });
      let previousNatives = false;
      try {
        for (const archive of files.natives)
          safeExtractZip(new AdmZip(archive.path), nativesStage, (name) =>
            nativeExtractionAllowed(name, archive.excludes),
          );
        try {
          const stat = await fs.lstat(nativesDirectory);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("原生库目录不能使用链接或普通文件");
          await fs.rename(nativesDirectory, nativesBackup);
          previousNatives = true;
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
        try {
          await fs.rename(nativesStage, nativesDirectory);
        } catch (error) {
          if (previousNatives) await fs.rename(nativesBackup, nativesDirectory);
          throw error;
        }
        if (previousNatives)
          await fs.rm(nativesBackup, { recursive: true, force: true });
      } finally {
        await fs.rm(nativesStage, { recursive: true, force: true });
      }
      plan.completeStage("natives");
      await plan.ready();
      plan.startStage("assets");
      let assetIndex: any = { objects: {} };
      if (metadata.assetIndex?.url) {
        const assetId = safeId(metadata.assetIndex.id);
        const indexFile = path.join(
          this.root,
          "assets",
          "indexes",
          `${assetId}.json`,
        );
        await this.downloads.downloadVerified(
          {
            url: metadata.assetIndex.url,
            path: indexFile,
            sha1: metadata.assetIndex.sha1,
            size: metadata.assetIndex.size,
          },
          "下载游戏资源索引",
          plan.context("assets"),
        );
        assetIndex = JSON.parse(await fs.readFile(indexFile, "utf8"));
        const assets: DownloadItem[] = Object.entries(
          assetIndex.objects || {},
        ).map(([name, object]: [string, any]) => {
          if (!/^[a-f0-9]{40}$/.test(object.hash))
            throw new Error("无效资源哈希");
          return {
            url: `https://resources.download.minecraft.net/${object.hash.slice(0, 2)}/${object.hash}`,
            path: path.join(
              this.root,
              "assets",
              "objects",
              object.hash.slice(0, 2),
              object.hash,
            ),
            sha1: object.hash,
            size: object.size,
            name,
          };
        });
        await this.downloads.downloadMany(
          assets,
          "补全游戏音效与资源",
          plan.context("assets"),
        );
        if (assetIndex.virtual || assetIndex.map_to_resources) {
          const legacyRoot = assetIndex.map_to_resources
            ? path.join(gameDirectory, "resources")
            : path.join(this.root, "assets", "virtual", assetId);
          for (const [name, value] of Object.entries(
            assetIndex.objects || {},
          )) {
            const target = path.resolve(legacyRoot, name);
            if (!target.startsWith(path.resolve(legacyRoot) + path.sep))
              throw new Error("资源路径越界");
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(
              path.join(
                this.root,
                "assets",
                "objects",
                (value as any).hash.slice(0, 2),
                (value as any).hash,
              ),
              target,
            );
          }
        }
      }
      plan.completeStage("assets");
      await plan.ready();
      plan.startStage("logging");
      if (metadata.logging?.client?.file?.url) {
        const log = metadata.logging.client.file;
        const filename = path.join(
          this.root,
          "assets",
          "log_configs",
          safeId(log.id),
        );
        await this.downloads.downloadVerified(
          { url: log.url, path: filename, sha1: log.sha1, size: log.size },
          "下载日志运行配置",
          plan.context("logging"),
        );
      }
      plan.completeStage("logging");
      if (!inputPlan) plan.complete();
      return {
        classpath: [...files.classpath, clientFile],
        natives: nativesDirectory,
        assetIndex,
      };
    } catch (error) {
      plan.fail(error);
      throw error;
    }
  }

  async install(input: {
    version: string;
    name?: string;
    loader?: Instance["loader"];
    loaderVersion?: string;
  }): Promise<Instance> {
    safeId(input.version);
    const lock = `${input.version}:${input.loader || "vanilla"}`;
    if (this.installing.has(lock))
      throw new Error("此版本正在安装，请等待完成");
    this.installing.add(lock);
    const id = randomUUID();
    const stage = path.join(this.dataDir, "cache", `install-${id}`);
    const plan = this.downloads.createPlan({
      title: `安装 Minecraft ${input.version}${input.loader && input.loader !== "vanilla" ? ` · ${input.loader}` : ""}`,
      context: {
        resourceName: `Minecraft ${input.version}`,
        targetInstanceId: id,
        targetInstanceName:
          input.name?.trim() ||
          `${input.version}${input.loader && input.loader !== "vanilla" ? ` · ${input.loader}` : ""}`,
      },
      stages: [
        { id: "metadata", title: "解析版本与安装信息" },
        { id: "loader", title: "安装加载器" },
        { id: "libraries", title: "游戏本体与运行库" },
        { id: "natives", title: "解压原生运行库" },
        { id: "assets", title: "音效、贴图与游戏资源" },
        { id: "logging", title: "日志运行配置" },
        { id: "finish", title: "保存独立游戏实例" },
      ],
    });
    let allocation: { id: string; path: string } | undefined;
    try {
      await plan.ready();
      plan.startStage("metadata");
      await fs.mkdir(this.root, { recursive: true });
      const defaultName = `${input.version}${input.loader && input.loader !== "vanilla" ? "-" + input.loader : ""}`;
      let preferred = defaultName;
      if (input.name?.trim()) {
        try {
          preferred = safeId(input.name.trim());
        } catch {}
      }
      allocation = await allocateVersionDirectory(this.root, preferred);
      const gameDirectory = allocation.path;
      await fs.mkdir(stage, { recursive: true });
      // Official installers only see a fresh staging root; native profiles and
      // their worlds cannot be overwritten by a newly installed instance.
      const workerEmit: Emit = (event) => {
        if (event.type === "task" && event.task && !event.task.download) {
          const task = {
            ...event.task,
            download: {
              ...plan.context("loader"),
              kind: "files" as const,
              progressMode: "indeterminate" as const,
            },
          };
          plan.observe(task);
          this.emit({ ...event, task });
        } else this.emit(event);
      };
      const worker = new GameService(this.dataDir, workerEmit, {
        minecraftRoot: stage,
      });
      worker.downloads = this.downloads.scoped(plan.context("metadata"));
      const vanilla = await worker.vanilla(input.version);
      await worker.saveVersion(vanilla);
      plan.completeStage("metadata");
      await plan.ready();
      plan.startStage("loader");
      worker.downloads = this.downloads.scoped(plan.context("loader"));
      worker.java = new JavaManager(this.dataDir, workerEmit, worker.downloads);
      let launchVersion = input.version,
        loaderVersion: string | undefined;
      if (input.loader && input.loader !== "vanilla") {
        if (
          input.loader === "forge" ||
          input.loader === "neoforge" ||
          input.loader === "optifine"
        ) {
          if (!vanilla.downloads?.client?.url)
            throw new Error("原版元数据缺少客户端 JAR");
          await worker.downloads.download(
            vanilla.downloads.client.url,
            path.join(stage, "versions", input.version, `${input.version}.jar`),
            vanilla.downloads.client.sha1,
            vanilla.downloads.client.size,
          );
        }
        const profile = await worker.loaderProfile(
          input.version,
          input.loader,
          input.loaderVersion,
        );
        launchVersion = profile.id;
        loaderVersion = profile.loaderVersion;
      }
      const resolved = await worker.metadata(launchVersion);
      plan.completeStage("loader");
      const own = {
        ...resolved,
        id: allocation.id,
        jar: allocation.id,
        minecraftVersion: input.version,
      };
      delete own.inheritsFrom;
      delete own._clientId;
      delete own._ownClient;
      await this.saveVersion(own);
      const stagedClient = path.join(
        stage,
        "versions",
        safeId(resolved._clientId),
        `${safeId(resolved._clientId)}.jar`,
      );
      try {
        await assertPlainTree(stagedClient);
        await fs.copyFile(
          stagedClient,
          path.join(gameDirectory, `${allocation.id}.jar`),
        );
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      // Forge's processors produce patched libraries which may have no public
      // download URL. Publish only new files, preserving existing shared data.
      const stagedLibraries = path.join(stage, "libraries");
      try {
        await assertPlainTree(stagedLibraries);
        await fs.cp(stagedLibraries, path.join(this.root, "libraries"), {
          recursive: true,
          force: false,
        });
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      await this.prepare(
        {
          ...own,
          _clientId: allocation.id,
          _ownClient: !!own.downloads?.client,
        },
        gameDirectory,
        plan,
      );
      await plan.ready();
      plan.startStage("finish");
      const instance: Instance = {
        id,
        name: (
          input.name?.trim() ||
          `${input.version}${input.loader && input.loader !== "vanilla" ? " · " + input.loader : ""}`
        ).slice(0, 100),
        version: input.version,
        loader: input.loader || "vanilla",
        loaderVersion,
        versionDirectory: allocation.id,
        createdAt: new Date().toISOString(),
        gameSettings: {},
      };
      await fs.mkdir(path.join(gameDirectory, ".ldfcl"), { recursive: true });
      await fs.writeFile(
        path.join(gameDirectory, ".ldfcl", "launch.json"),
        JSON.stringify({ version: allocation.id }),
        "utf8",
      );
      await fs.writeFile(
        path.join(gameDirectory, "instance.json"),
        JSON.stringify(instance, null, 2),
        "utf8",
      );
      plan.completeStage("finish");
      plan.complete();
      return instance;
    } catch (error) {
      plan.fail(error);
      // This directory was atomically reserved by this installation only.
      if (allocation)
        await fs.rm(allocation.path, { recursive: true, force: true });
      throw error;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
      this.installing.delete(lock);
    }
  }

  private async launchVersion(instance: Instance): Promise<string> {
    if (instance.versionDirectory || instance.importedVersionId) {
      const id = instanceVersionDirectoryId(instance);
      try {
        await assertInstanceGameDirectory(this.root, instance);
        const root = await fs.realpath(this.root);
        const versions = await fs.realpath(path.join(root, "versions"));
        const versionRelative = path.relative(root, versions);
        if (
          path.isAbsolute(versionRelative) ||
          versionRelative === ".." ||
          versionRelative.startsWith(".." + path.sep)
        )
          throw new Error("版本目录路径越界");
        const file = await fs.realpath(path.join(versions, id, `${id}.json`));
        const relative = path.relative(versions, file);
        if (
          path.isAbsolute(relative) ||
          relative === ".." ||
          relative.startsWith(".." + path.sep)
        )
          throw new Error("版本配置路径越界");
        const metadata = JSON.parse(await fs.readFile(file, "utf8"));
        if (!metadata || metadata.id !== id)
          throw new Error("版本配置标识不符");
      } catch {
        throw new Error(
          "导入的本地版本配置已移动或损坏，请重新扫描此游戏目录。",
        );
      }
      return id;
    }
    throw new Error("实例版本目录尚未准备完成，请重新加载游戏目录并完成迁移");
  }

  async launch(
    instance: Instance,
    account: Account,
    settings: Settings,
  ): Promise<{ pid: number }> {
    if (this.starting.has(instance.id) || this.running.has(instance.id))
      throw new Error("此实例正在启动或已经运行");
    this.starting.add(instance.id);
    try {
      return await this.launchInternal(instance, account, settings);
    } finally {
      this.starting.delete(instance.id);
    }
  }

  private async launchInternal(
    instance: Instance,
    account: Account,
    settings: Settings,
  ): Promise<{ pid: number }> {
    safeId(instance.id);
    if (this.running.has(instance.id)) throw new Error("此实例已在运行");
    if (!account?.name || !account.uuid)
      throw new Error("请先选择有效的游戏账号");
    this.downloads.concurrency = Math.max(
      1,
      Math.min(32, Number(settings.downloadConcurrency) || 8),
    );
    const versionId = await this.launchVersion(instance);
    const metadata = await this.metadata(versionId);
    const gameDirectory = instanceGameDirectory(this.root, instance);
    const prepared = await this.prepare(metadata, gameDirectory, undefined, {
      resourceName: `Minecraft ${instance.version}`,
      targetInstanceId: instance.id,
      targetInstanceName: instance.name,
    });
    const javaPath = await this.java.ensure(
      metadata.javaVersion?.majorVersion || versionJava(instance.version),
      instance.javaPath || settings.javaPath,
    );
    const memory =
      instance.memoryMb ||
      (settings.memoryMode === "manual"
        ? settings.memoryMb
        : automaticMemoryMb());
    const memoryMb = Math.max(
      512,
      Math.min(
        Math.floor(os.totalmem() / 1048576 - 512),
        Math.floor(Number(memory) || 2048),
      ),
    );
    await this.writeSettings(
      gameDirectory,
      effectiveGameOptions(settings, instance),
    );
    const variables: Record<string, string> = {
      auth_player_name: account.name,
      version_name: versionId,
      game_directory: gameDirectory,
      assets_root: path.join(this.root, "assets"),
      assets_index_name: metadata.assetIndex?.id || metadata.assets || "",
      auth_uuid: account.uuid.replace(/-/g, ""),
      auth_access_token: account.accessToken || "0",
      auth_session: account.accessToken
        ? `token:${account.accessToken}:${account.uuid}`
        : "0",
      clientid: "",
      auth_xuid: (account as any).xuid || "",
      user_type: account.type === "microsoft" ? "msa" : "mojang",
      version_type: "LDFCL",
      user_properties: "{}",
      natives_directory: prepared.natives,
      launcher_name: "LDFCL",
      launcher_version: LAUNCHER_VERSION,
      classpath: prepared.classpath.join(path.delimiter),
      classpath_separator: path.delimiter,
      library_directory: path.join(this.root, "libraries"),
      primary_jar: prepared.classpath[prepared.classpath.length - 1],
      resolution_width: "1280",
      resolution_height: "720",
      game_assets: prepared.assetIndex.virtual
        ? path.join(this.root, "assets", "virtual", variablesAssetId(metadata))
        : path.join(gameDirectory, "resources"),
    };
    const declaredJvm = metadata.arguments?.jvm?.length
      ? expandArguments(metadata.arguments.jvm, variables)
      : [];
    const jvm = prepareJvmArguments(
      declaredJvm,
      variables.classpath,
      prepared.natives,
    );
    const args = [
      `-Xms${Math.min(512, memoryMb)}M`,
      `-Xmx${memoryMb}M`,
      "-Dfile.encoding=UTF-8",
      ...validateExtraJvmArguments(instance.jvmArgs ?? settings.jvmArgs ?? []),
      ...jvm,
    ];
    if (metadata.logging?.client?.argument)
      args.push(
        metadata.logging.client.argument.replace(
          "${path}",
          path.join(
            this.root,
            "assets",
            "log_configs",
            safeId(metadata.logging.client.file.id),
          ),
        ),
      );
    if (account.type === "yggdrasil") {
      if (!account.server || !account.accessToken)
        throw new Error("皮肤站登录信息不完整，请重新登录");
      const info = await requestJson<any>(
        "https://authlib-injector.yushi.moe/artifact/latest.json",
      );
      const injector = path.join(
        this.dataDir,
        "runtime",
        `authlib-injector-${Number(info.build_number) || "latest"}.jar`,
      );
      await this.downloads.download(
        info.download_url,
        injector,
        info.checksums?.sha1,
        undefined,
        "补全皮肤站认证组件",
      );
      if (
        info.checksums?.sha256 &&
        (await fileHash(injector, "sha256")) !==
          String(info.checksums.sha256).toLowerCase()
      ) {
        await fs.rm(injector, { force: true });
        throw new Error("皮肤站认证组件 SHA-256 校验失败，请重试");
      }
      args.push(
        `-javaagent:${injector}=${account.server}`,
        "-Dauthlibinjector.side=client",
      );
    }
    const expandedGame = metadata.arguments?.game?.length
      ? expandArguments(metadata.arguments.game, variables)
      : expandArguments(
          tokenizeArguments(metadata.minecraftArguments || ""),
          variables,
        );
    const game = isolateGameDirectoryArguments(expandedGame, gameDirectory);
    if (!metadata.mainClass) throw new Error("版本缺少游戏入口");
    const secrets = [
      account.accessToken,
      account.refreshToken,
      account.clientToken,
    ].filter((secret): secret is string => !!secret);
    const mods: DiagnosisMod[] = [];
    const modDirectory = path.join(gameDirectory, "mods");
    for (const entry of (
      await fs.readdir(modDirectory, { withFileTypes: true }).catch(() => [])
    ).slice(0, 10000)) {
      if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue;
      try {
        const file = path.join(modDirectory, entry.name);
        if ((await fs.stat(file)).size > 512 * 1024 * 1024) continue;
        const zip = new AdmZip(file);
        const metadata = readModMetadata((name) => {
          const item = zip.getEntry(name);
          return item && item.header.size < 4 * 1024 * 1024
            ? item.getData().toString("utf8")
            : null;
        }, entry.name);
        mods.push({ ...metadata, filename: entry.name });
      } catch {
        /* An unreadable mod must not prevent log capture or game launch. */
      }
    }
    const invocation = await prepareJavaLaunch({
      executable: javaPath,
      jvmArguments: args,
      mainClass: metadata.mainClass,
      gameArguments: game,
      classpath: prepared.classpath,
      cwd: gameDirectory,
      roots: [this.root, this.dataDir],
    });
    let session;
    try {
      session = await this.diagnostics.begin({
        instanceId: instance.id,
        gameDirectory,
        secrets,
        mods,
        onLine: (line, stream, runId) =>
          this.emit({
            type: "log",
            instanceId: instance.id,
            line,
            stream,
            runId,
          }),
      });
    } catch (error) {
      await invocation.dispose();
      throw error;
    }
    this.sessions.set(instance.id, session);
    let child: ChildProcess;
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        windowsHide: true,
        stdio: [invocation.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (error) {
      this.sessions.delete(instance.id);
      await invocation.dispose();
      const message = error instanceof Error ? error.message : String(error);
      await session
        .finish({ exitCode: null, spawnError: message })
        .catch(() => {});
      this.emit({
        type: "game",
        status: "error",
        instanceId: instance.id,
        running: false,
        error: message,
      });
      throw error;
    }
    if (invocation.stdin && child.stdin) {
      // An early JVM failure may close stdin before the payload is drained.
      // Its exit/error and diagnostics remain authoritative; avoid EPIPE leaks.
      child.stdin.on("error", () => {});
      child.stdin.end(invocation.stdin);
    }
    this.running.set(instance.id, child);
    child.stdout?.on("data", (chunk) => session.capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => session.capture("stderr", chunk));
    child.on("close", (code, signal) => {
      void invocation.dispose().catch(() => {});
      this.running.delete(instance.id);
      this.sessions.delete(instance.id);
      void session.finish({ exitCode: code, signal }).catch(() => {});
      this.emit({
        type: "game",
        status: "exited",
        instanceId: instance.id,
        running: false,
        exitCode: code,
      });
    });
    return new Promise((resolve, reject) => {
      child.once("error", (error) => {
        void invocation.dispose().catch(() => {});
        this.running.delete(instance.id);
        this.sessions.delete(instance.id);
        void session
          .finish({ exitCode: null, spawnError: error.message })
          .catch(() => {});
        this.emit({
          type: "game",
          status: "error",
          instanceId: instance.id,
          running: false,
          error: error.message,
        });
        reject(error);
      });
      child.once("spawn", () => {
        this.emit({
          type: "game",
          status: "started",
          instanceId: instance.id,
          running: true,
          pid: child.pid,
        });
        resolve({ pid: child.pid! });
      });
    });
  }

  private async writeSettings(
    directory: string,
    settings: Record<string, string | number | boolean>,
  ): Promise<void> {
    const filename = path.join(directory, "options.txt");
    const existing = await fs.readFile(filename, "utf8").catch(() => "");
    const values = new Map<string, string>();
    for (const line of existing.split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
    }
    // Core/CLI callers also launch without the GUI's pre-launch save path.
    if (!values.get("lang")?.trim())
      values.set("lang", String(GAME_OPTION_DEFAULTS.lang));
    for (const [key, value] of Object.entries(settings)) {
      if (!/^[a-zA-Z0-9_]+$/.test(key) || /[\r\n]/.test(String(value)))
        throw new Error("游戏设置包含无效字符");
      values.set(key, String(value));
    }
    await fs.writeFile(
      filename,
      [...values].map(([key, value]) => `${key}:${value}`).join("\n") +
        (values.size ? "\n" : ""),
      "utf8",
    );
  }

  async stop(id: string): Promise<void> {
    const child = this.running.get(id);
    if (!child) return;
    this.sessions.get(id)?.markStopped();
    if (process.platform === "win32" && child.pid) {
      try {
        await runProcess(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          undefined,
          undefined,
          15000,
        );
      } catch {
        if (!child.killed && child.exitCode === null) child.kill();
      }
    } else child.kill();
  }

  async runtimeInfo(): Promise<any> {
    return {
      totalMemoryMb: Math.floor(os.totalmem() / 1048576),
      freeMemoryMb: Math.floor(os.freemem() / 1048576),
      suggestedMemoryMb: automaticMemoryMb(),
      java: await this.java.discover(),
      platform: process.platform,
      arch: process.arch,
      running: [...this.running].map(([id, child]) => ({ id, pid: child.pid })),
    };
  }
}

function variablesAssetId(metadata: any): string {
  return safeId(metadata.assetIndex?.id || metadata.assets || "legacy");
}
