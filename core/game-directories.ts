import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { GameDirectory, Instance } from "../shared/types";

export interface DefaultGameDirectoryOptions {
  isPackaged: boolean;
  execPath: string;
  appPath: string;
  portableExecutableDir?: string;
  dataDirOverride?: string;
  gameRootOverride?: string;
}

function absolutePath(value: string): string {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value))
    throw new Error("游戏目录必须使用完整的绝对路径。");
  return path.resolve(value);
}

/** Resolve without creating or moving any directory. Portable Electron runs in
 * a temporary extraction folder, so its external executable directory wins. */
export function resolveDefaultGameDirectoryPath(
  options: DefaultGameDirectoryOptions,
): string {
  if (options.gameRootOverride) return absolutePath(options.gameRootOverride);
  if (options.dataDirOverride)
    return path.join(absolutePath(options.dataDirOverride), ".minecraft");
  const base = options.isPackaged
    ? options.portableExecutableDir
      ? absolutePath(options.portableExecutableDir)
      : path.dirname(absolutePath(options.execPath))
    : absolutePath(options.appPath);
  return path.join(base, ".minecraft");
}

/** Use this key after realpath canonicalization, so aliases and Windows casing
 * cannot register the same physical folder more than once. */
export function gameDirectoryPathKey(
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = absolutePath(canonicalPath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function gameDirectoryRoots(directory: GameDirectory): {
  dataDir: string;
  minecraftRoot: string;
} {
  const dataDir = absolutePath(directory.path);
  return {
    dataDir,
    minecraftRoot:
      directory.layout === "legacy" ? path.join(dataDir, "minecraft") : dataDir,
  };
}

/** Validate a user-selected existing folder, including an actual write probe.
 * The probe is exclusive and removed; existing user data is never touched. */
export async function canonicalGameDirectoryPath(
  value: string,
): Promise<string> {
  const selected = absolutePath(value);
  let canonical: string;
  try {
    canonical = await fs.realpath(selected);
    if (!(await fs.stat(canonical)).isDirectory())
      throw new Error("not-directory");
  } catch {
    throw new Error(
      "游戏目录已不存在或不是文件夹，可能已被移动或删除。请重新定位或移除该目录登记。",
    );
  }
  const probe = path.join(canonical, `.ldfcl-write-probe-${randomUUID()}`);
  let created = false;
  try {
    await fs.access(canonical, constants.R_OK | constants.W_OK);
    const handle = await fs.open(probe, "wx");
    created = true;
    try {
      await handle.writeFile("LDFCL directory permission probe");
    } finally {
      await handle.close();
    }
    await fs.unlink(probe);
    created = false;
  } catch {
    throw new Error("无法读写所选游戏目录，请选择有读写权限的文件夹。");
  } finally {
    if (created) await fs.unlink(probe).catch(() => {});
  }
  return path.resolve(canonical);
}

/** A single Windows-safe segment also accepts common Chinese and spaced local
 * profile names. This is deliberately stricter than path.normalize alone. */
export function safeGameVersionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 180 ||
    /[\\/<>:"|?*\u0000-\u001f\u007f]/.test(value) ||
    /[. ]$/.test(value) ||
    value === "." ||
    value === ".." ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
    throw new Error("无效的游戏版本标识");
  return value;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

const minecraftVersion =
  /^(?:1\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+| Pre-Release \d+| Release Candidate \d+)?|2\d\.\d+(?:\.\d+)?(?:-(?:pre|rc|snapshot)-?\d+)?|\d{2}w\d{2}[a-z]|[ab]1\.\d+(?:\.\d+)?(?:_\d+)?|c0\.[\d_]+|rd-\d+|inf-\d+)$/i;
const maximumProfiles = 4096;
const maximumMetadataBytes = 8 * 1024 * 1024;

type LocalProfile = { id: string; metadata: any; createdAt: string };

function loaderDetails(
  chain: LocalProfile[],
  version: string,
): {
  loader: Instance["loader"];
  loaderVersion?: string;
} {
  const libraries = chain.flatMap(
    (profile) => profile.metadata.libraries || [],
  );
  for (const [loader, prefix] of [
    ["quilt", "org.quiltmc:quilt-loader:"],
    ["fabric", "net.fabricmc:fabric-loader:"],
    ["forge", "net.minecraftforge:forge:"],
    ["optifine", "optifine:OptiFine:"],
  ] as const) {
    const library = libraries.find(
      (item: any) =>
        typeof item?.name === "string" && item.name.startsWith(prefix),
    );
    if (library) {
      let loaderVersion = library.name.slice(prefix.length).split(":")[0];
      if (loader === "forge" && loaderVersion.startsWith(version + "-"))
        loaderVersion = loaderVersion.slice(version.length + 1);
      if (loader === "optifine" && loaderVersion.startsWith(version + "_"))
        loaderVersion = loaderVersion.slice(version.length + 1);
      return { loader, loaderVersion };
    }
  }
  const signature = chain
    .map((profile) => `${profile.id} ${profile.metadata.mainClass || ""}`)
    .join(" ")
    .toLowerCase();
  if (/quilt/.test(signature)) return { loader: "quilt" };
  if (/fabric/.test(signature)) return { loader: "fabric" };
  if (/forge|cpw\.mods\.|net\.minecraftforge\./.test(signature))
    return { loader: "forge" };
  if (/optifine/.test(signature)) return { loader: "optifine" };
  return { loader: "vanilla" };
}

function baseVersion(
  chain: LocalProfile[],
  missingParent?: string,
): string | undefined {
  // The oldest inherited profile is the most reliable Minecraft version.
  if (missingParent && minecraftVersion.test(missingParent))
    return missingParent;
  for (const profile of [...chain].reverse()) {
    const metadata = profile.metadata;
    const args = Array.isArray(metadata.arguments?.game)
      ? metadata.arguments.game
      : [];
    const mcArgument = args.indexOf("--fml.mcVersion");
    const forgeLibrary = (metadata.libraries || []).find(
      (item: any) =>
        typeof item?.name === "string" &&
        item.name.startsWith("net.minecraftforge:forge:"),
    );
    const candidates = [
      metadata.clientVersion,
      metadata.minecraftVersion,
      mcArgument >= 0 ? args[mcArgument + 1] : undefined,
      metadata.jar,
      profile.id,
      forgeLibrary?.name.split(":")[2]?.split("-")[0],
    ];
    for (const value of candidates)
      if (typeof value === "string" && minecraftVersion.test(value))
        return value;
  }
  return undefined;
}

/** Read-only import: no options.txt, mods, saves, profile JSON or directories
 * are created or changed. Each registered profile uses its version folder as gameDir. */
export async function scanGameDirectory(directory: GameDirectory): Promise<{
  instances: Instance[];
  warnings: string[];
}> {
  const instances: Instance[] = [],
    warnings: string[] = [];
  if (directory.layout === "legacy") return { instances, warnings };
  const root = absolutePath(directory.path);
  let canonicalRoot: string, versions: string;
  try {
    canonicalRoot = await fs.realpath(root);
    versions = await fs.realpath(path.join(canonicalRoot, "versions"));
    if (!contained(canonicalRoot, versions))
      throw new Error("版本目录指向所选游戏目录之外");
    if (!(await fs.stat(versions)).isDirectory())
      throw new Error("versions 不是文件夹");
  } catch (error: any) {
    if (error.code !== "ENOENT")
      warnings.push(`无法扫描版本目录：${error.message}`);
    return { instances, warnings };
  }
  let entries;
  try {
    entries = await fs.readdir(versions, { withFileTypes: true });
  } catch (error: any) {
    warnings.push(`无法读取版本目录：${error.message}`);
    return { instances, warnings };
  }
  const cache = new Map<string, Promise<LocalProfile | undefined>>();
  const readProfile = (id: string): Promise<LocalProfile | undefined> => {
    if (cache.has(id)) return cache.get(id)!;
    const pending = (async () => {
      safeGameVersionId(id);
      const folder = await fs.realpath(path.join(versions, id));
      if (!contained(versions, folder))
        throw new Error("版本文件夹指向游戏目录之外");
      const file = await fs.realpath(path.join(folder, `${id}.json`));
      if (!contained(folder, file))
        throw new Error("版本 JSON 指向版本文件夹之外");
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > maximumMetadataBytes)
        throw new Error("版本 JSON 不是文件或超过 8 MB");
      const metadata = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        metadata.id !== id
      )
        throw new Error("版本 JSON 的 id 与文件夹名称不符");
      if (
        metadata.libraries !== undefined &&
        !Array.isArray(metadata.libraries)
      )
        throw new Error("版本 libraries 配置无效");
      if (
        typeof metadata.mainClass !== "string" &&
        typeof metadata.inheritsFrom !== "string"
      )
        throw new Error("缺少游戏主类或继承版本");
      if (metadata.inheritsFrom !== undefined)
        safeGameVersionId(metadata.inheritsFrom);
      if (metadata.jar !== undefined) safeGameVersionId(metadata.jar);
      return { id, metadata, createdAt: stat.birthtime.toISOString() };
    })();
    cache.set(id, pending);
    return pending;
  };
  const folders = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));
  if (folders.length > maximumProfiles)
    warnings.push(
      `版本数量超过 ${maximumProfiles}，仅扫描前 ${maximumProfiles} 个。`,
    );
  for (const entry of folders.slice(0, maximumProfiles)) {
    try {
      if (entry.isSymbolicLink()) throw new Error("跳过链接版本文件夹");
      const profile = await readProfile(entry.name);
      if (!profile) continue;
      const chain = [profile],
        visited = new Set([profile.id]);
      let cursor = profile,
        missingParent: string | undefined;
      while (cursor.metadata.inheritsFrom) {
        const parentId = safeGameVersionId(cursor.metadata.inheritsFrom);
        if (visited.has(parentId)) throw new Error("版本继承存在循环");
        if (chain.length >= 8) throw new Error("版本继承层数超过 8 层");
        visited.add(parentId);
        let parent: LocalProfile | undefined;
        try {
          parent = await readProfile(parentId);
        } catch (error: any) {
          if (error.code !== "ENOENT" || !minecraftVersion.test(parentId))
            throw error;
          missingParent = parentId;
          warnings.push(
            `${entry.name}：缺少基础版本 ${parentId}，启动时需要联网补齐。`,
          );
          break;
        }
        if (!parent) break;
        chain.push(parent);
        cursor = parent;
      }
      const version = baseVersion(chain, missingParent);
      if (!version) throw new Error("无法识别实际 Minecraft 基础版本");
      instances.push({
        id: `local-${createHash("sha256")
          .update(JSON.stringify([directory.id, profile.id]))
          .digest("hex")
          .slice(0, 24)}`,
        name: profile.id,
        version,
        ...loaderDetails(chain, version),
        createdAt: profile.createdAt,
        gameSettings: {},
        gameDirectoryId: directory.id,
        importedVersionId: profile.id,
        versionDirectory: profile.id,
      });
    } catch (error: any) {
      warnings.push(`${entry.name}：已跳过，${error.message}`);
    }
  }
  return { instances, warnings };
}
