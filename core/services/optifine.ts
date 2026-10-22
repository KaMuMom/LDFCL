import { promises as fs } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import type { OptifineVersion } from "../../shared/types";
import { safeGameVersionId } from "../game-directories";
import { assertPlainTree } from "../instance-paths";
import { DownloadManager, type Emit, fileHash, requestJson } from "./downloads";
import { type JavaManager, runProcess } from "./java";
import { OPTIFINE_BRIDGE } from "./optifine-bridge";

// BMCLAPI mirrors unmodified OptiFine installers. OptiFine remains the work of
// sp614x; no OptiFine code or installer is distributed with LDFCL.
export const OPTIFINE_SOURCE = "https://bmclapi2.bangbang93.com";
const token = /^[A-Za-z0-9_]{1,64}$/;

export function normalizeOptifineVersions(
  response: unknown,
  minecraftVersion: string,
): OptifineVersion[] {
  if (!Array.isArray(response))
    throw new Error("OptiFine 版本服务返回了无效数据");
  const seen = new Set<string>();
  return response
    .flatMap((item: any): OptifineVersion[] => {
      if (
        !item ||
        item.mcversion !== minecraftVersion ||
        typeof item.type !== "string" ||
        !token.test(item.type) ||
        typeof item.patch !== "string" ||
        !token.test(item.patch) ||
        typeof item.filename !== "string"
      )
        return [];
      const id = `${item.type}_${item.patch}`;
      const preview =
        item.filename?.startsWith("preview_") || /(?:^|_)pre\d/i.test(id);
      const filename = `${preview ? "preview_" : ""}OptiFine_${minecraftVersion}_${id}.jar`;
      if (item.filename !== filename || seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id,
          minecraftVersion,
          type: item.type,
          patch: item.patch,
          filename,
          preview: !!preview,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(a.preview) - Number(b.preview) ||
        b.id.localeCompare(a.id, "en", { numeric: true }),
    );
}

export async function optifineVersions(
  version: string,
): Promise<OptifineVersion[]> {
  safeGameVersionId(version);
  try {
    return normalizeOptifineVersions(
      await requestJson(
        `${OPTIFINE_SOURCE}/optifine/${encodeURIComponent(version)}`,
      ),
      version,
    );
  } catch (error: any) {
    throw new Error(
      `无法获取 Minecraft ${version} 的 OptiFine 版本，请检查网络后重试。${error.message || error}`,
    );
  }
}

export function optifineDownloadUrl(release: OptifineVersion): string {
  safeGameVersionId(release.minecraftVersion);
  if (
    !token.test(release.type) ||
    !token.test(release.patch) ||
    release.id !== `${release.type}_${release.patch}`
  )
    throw new Error("无效的 OptiFine 发行版本");
  return `${OPTIFINE_SOURCE}/optifine/${encodeURIComponent(release.minecraftVersion)}/${encodeURIComponent(release.type)}/${encodeURIComponent(release.patch)}`;
}

/** Verify the installer's actual output before the GameService publishes it. */
export async function validateOptifineProfile(
  minecraftRoot: string,
  release: OptifineVersion,
): Promise<string> {
  const id = safeGameVersionId(
    `${release.minecraftVersion}-OptiFine_${release.id}`,
  );
  const file = path.join(minecraftRoot, "versions", id, `${id}.json`);
  await assertPlainTree(path.dirname(file));
  const stat = await fs.stat(file);
  if (stat.size > 8 * 1024 * 1024) throw new Error("OptiFine 版本配置过大");
  const profile = JSON.parse(await fs.readFile(file, "utf8"));
  const expected = `optifine:OptiFine:${release.minecraftVersion}_${release.id}`;
  if (
    profile.id !== id ||
    profile.inheritsFrom !== release.minecraftVersion ||
    profile.mainClass !== "net.minecraft.launchwrapper.Launch" ||
    !Array.isArray(profile.libraries) ||
    !profile.libraries.some((library: any) => library?.name === expected)
  )
    throw new Error("OptiFine 安装器没有生成匹配的启动配置");
  const argumentsText = JSON.stringify(
    profile.arguments || profile.minecraftArguments || "",
  );
  if (!argumentsText.includes("optifine.OptiFineTweaker"))
    throw new Error("OptiFine 启动配置缺少 OptiFineTweaker");
  for (const library of profile.libraries) {
    if (!library.name?.startsWith("optifine:")) continue;
    const parts = String(library.name).split(":");
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
    )
      throw new Error("OptiFine 安装器生成了无效的运行库路径");
    const [group, artifact, version] = parts;
    const relative = `${group}/${artifact}/${version}/${artifact}-${version}.jar`;
    const local = path.join(minecraftRoot, "libraries", relative);
    await assertPlainTree(local);
    const libraryStat = await fs.stat(local);
    const jar = new AdmZip(local);
    if (
      !libraryStat.size ||
      !jar.getEntries().length ||
      (library.name === expected &&
        !jar.getEntry("optifine/OptiFineTweaker.class"))
    )
      throw new Error("OptiFine 安装器未生成完整的已修补运行库");
    // These generated jars have no public Maven URL. Retain their real hashes
    // so the common launch preparation verifies rather than replaces them.
    library.downloads = {
      artifact: {
        path: relative,
        sha1: await fileHash(local),
        size: libraryStat.size,
      },
    };
  }
  await fs.writeFile(file, JSON.stringify(profile, null, 2), "utf8");
  return id;
}

export async function installOptifine(input: {
  dataDir: string;
  minecraftRoot: string;
  version: string;
  requested?: string;
  javaMajor: number;
  java: JavaManager;
  downloads: DownloadManager;
  emit: Emit;
}): Promise<{ id: string; loaderVersion: string }> {
  const releases = await optifineVersions(input.version);
  const selected = input.requested
    ? releases.find((release) => release.id === input.requested)
    : releases[0];
  if (!selected)
    throw new Error(
      input.requested
        ? `Minecraft ${input.version} 没有可用的 OptiFine ${input.requested}，请刷新并重新选择`
        : `OptiFine 暂不支持 Minecraft ${input.version}，可选择原版或其他游戏版本`,
    );
  const installer = path.join(
    input.dataDir,
    "cache",
    "optifine",
    selected.filename,
  );
  const taskId = `optifine-${input.version}-${selected.id}`;
  const task = (status: string, progress: number, detail?: string) =>
    input.emit({
      type: "task",
      task: {
        id: taskId,
        title: `安装 OptiFine ${selected.id}`,
        status,
        progress,
        detail,
      },
    });
  task("running", 0, "从 BMCLAPI 获取 OptiFine 官方安装器");
  let validInstaller = false;
  try {
    await input.downloads.downloadVerified(
      {
        url: optifineDownloadUrl(selected),
        path: installer,
        requireHttps: true,
        maxBytes: 64 * 1024 * 1024,
      },
      "下载 OptiFine 安装器（BMCLAPI）",
    );
    const jar = new AdmZip(installer);
    if (
      !jar.getEntry("optifine/Installer.class") ||
      !jar.getEntry("optifine/Patcher.class")
    )
      throw new Error("下载文件不是受支持的 OptiFine 官方安装器");
    validInstaller = true;
    const java = await input.java.ensure(input.javaMajor);
    const bridgeDirectory = path.join(
      input.minecraftRoot,
      ".ldfcl-optifine-installer",
    );
    await fs.mkdir(bridgeDirectory, { recursive: true });
    await fs.writeFile(
      path.join(bridgeDirectory, "OptiFineBridge.class"),
      Buffer.from(OPTIFINE_BRIDGE, "base64"),
    );
    await fs.writeFile(
      path.join(input.minecraftRoot, "launcher_profiles.json"),
      '{"profiles":{}}',
      "utf8",
    );
    task("running", 0.4, "运行官方补丁与安装流程");
    const result = await runProcess(
      java,
      [
        "-Djava.awt.headless=true",
        "-cp",
        [bridgeDirectory, installer].join(path.delimiter),
        "OptiFineBridge",
        input.minecraftRoot,
        input.version,
        selected.id,
      ],
      input.minecraftRoot,
      (line) => input.emit({ type: "log", instanceId: "installer", line }),
    );
    if (
      !result.stdout.includes(
        `LDFCL_OPTIFINE_INSTALLED OptiFine_${input.version}_${selected.id}`,
      )
    )
      throw new Error("OptiFine 官方安装器未确认安装成功");
    const id = await validateOptifineProfile(input.minecraftRoot, selected);
    task("completed", 1);
    return { id, loaderVersion: selected.id };
  } catch (error: any) {
    if (
      !validInstaller ||
      /Installer version mismatch|ClassFormatError|ZipException/.test(
        String(error.message || error),
      )
    )
      await fs.rm(installer, { force: true }).catch(() => {});
    task("failed", 0, error.message || String(error));
    throw new Error(`OptiFine 安装失败：${error.message || error}`);
  }
}
