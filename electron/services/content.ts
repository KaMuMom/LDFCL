import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import type { Instance, ModpackVersion } from "../../shared/types";
import { LAUNCHER_USER_AGENT } from "../../shared/launcher";
import {
  assertPlainTree,
  instanceGameDirectory,
  instanceVersionDirectoryId,
} from "../instance-paths";
import {
  ModTranslationCatalog,
  type LocalizedModFields,
} from "./mod-translations";
import { readModMetadata, findDuplicateMods } from "./mod-metadata";
import { DownloadManager } from "./downloads";

const API = "https://api.modrinth.com/v2";
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const MAX_EXPANDED = 4 * 1024 * 1024 * 1024;
type Emit = (event: any) => void;
type ProjectType = "mod" | "modpack" | "resourcepack" | "shader";
type Hashes = { sha1?: string; sha256?: string; sha512?: string };
type ModInfo = {
  file: string;
  name: string;
  id: string;
  ids: string[];
  version: string;
  description: string;
  enabled: boolean;
  size: number;
  sha512: string;
  sha1: string;
  projectId?: string;
  duplicate?: boolean;
} & Partial<LocalizedModFields>;
type InstallMetadata = Record<
  string,
  { projectId: string; versionId: string; versionName: string }
>;

function safeFile(name: string): string {
  if (
    !name ||
    name !== path.basename(name) ||
    /[\x00-\x1f<>:"/\\|?*]/.test(name) ||
    name === "." ||
    name === ".." ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error("文件名不安全");
  return name;
}

function packFile(version: any): any | undefined {
  const files = Array.isArray(version?.files) ? version.files : [];
  const candidates = files.filter((file: any) => {
    if (
      !file ||
      typeof file.filename !== "string" ||
      !/\.mrpack$/i.test(file.filename) ||
      typeof file.url !== "string"
    )
      return false;
    try {
      safeFile(file.filename);
      if (new URL(file.url).protocol !== "https:") return false;
    } catch {
      return false;
    }
    return (
      file.size === undefined ||
      (Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        file.size <= MAX_ARCHIVE)
    );
  });
  return candidates.find((file: any) => file.primary === true) || candidates[0];
}

function packVersionId(version: any): string | undefined {
  if (typeof version?.id !== "string" || !version.id) return undefined;
  try {
    return safeFile(version.id);
  } catch {
    return undefined;
  }
}

function publishedTime(version: any): number {
  const parsed =
    typeof version?.date_published === "string"
      ? Date.parse(version.date_published)
      : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function inside(root: string, relative: string): string {
  if (
    !relative ||
    relative.includes("\0") ||
    /(^|[\\/])\.\.([\\/]|$)/.test(relative) ||
    path.isAbsolute(relative) ||
    /^[a-zA-Z]:/.test(relative)
  )
    throw new Error("整合包包含不安全的路径");
  for (const part of relative.replace(/\\/g, "/").split("/")) safeFile(part);
  const target = path.resolve(root, relative.replace(/\\/g, "/"));
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw new Error("整合包路径超出实例目录");
  return target;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}
async function digest(file: string): Promise<Hashes> {
  const b = await fs.readFile(file);
  return {
    sha1: createHash("sha1").update(b).digest("hex"),
    sha512: createHash("sha512").update(b).digest("hex"),
  };
}
export class ContentService {
  private translations: ModTranslationCatalog;
  private minecraftRoot: string;
  private downloads: DownloadManager;
  constructor(
    private dataDir: string,
    private emit: Emit,
    private getConcurrency: () => number = () => 6,
    translationDataDir: string = dataDir,
    options: { minecraftRoot?: string } = {},
  ) {
    if (options.minecraftRoot && !path.isAbsolute(options.minecraftRoot))
      throw new Error("游戏资源目录必须使用完整的绝对路径。");
    this.minecraftRoot = options.minecraftRoot
      ? path.resolve(options.minecraftRoot)
      : path.join(dataDir, "minecraft");
    this.translations = new ModTranslationCatalog(translationDataDir);
    this.downloads = new DownloadManager(dataDir, emit, getConcurrency());
  }

  private instanceDir(instance: Instance): string {
    return instanceGameDirectory(this.minecraftRoot, instance);
  }
  private assertPackPath(relative: string, instance: Instance): void {
    const normalized = relative.replace(/\\/g, "/").toLowerCase();
    const versionId = instanceVersionDirectoryId(instance).toLowerCase();
    if (
      /^\.ldfcl/.test(normalized) ||
      /(^|\/)launcher_accounts\.json$/.test(normalized) ||
      normalized === "instance.json" ||
      normalized === `${versionId}.json` ||
      normalized === `${versionId}.jar`
    )
      throw new Error("整合包不能修改启动器配置或版本元数据");
  }
  private task(
    id: string,
    title: string,
    progress: number,
    status: string = "running",
    detail?: string,
  ) {
    this.emit({
      type: "task",
      task: {
        id,
        title,
        progress: Math.max(0, Math.min(100, progress)),
        status,
        detail,
      },
    });
  }

  private async request(route: string, init?: RequestInit): Promise<any> {
    const response = await fetch(`${API}${route}`, {
      ...init,
      headers: {
        "User-Agent": LAUNCHER_USER_AGENT,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok)
      throw new Error(
        `Modrinth 请求失败 (${response.status})${response.status === 429 ? "，请稍后重试" : ""}`,
      );
    return response.json();
  }

  private async metadata(instance: Instance): Promise<InstallMetadata> {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(this.instanceDir(instance), ".ldfcl-content.json"),
          "utf8",
        ),
      );
    } catch {
      return {};
    }
  }

  private async saveMetadata(
    instance: Instance,
    value: InstallMetadata,
  ): Promise<void> {
    const dest = path.join(this.instanceDir(instance), ".ldfcl-content.json");
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, dest);
  }

  /** Downloads into a temporary file and verifies every advertised digest before publishing it. */
  private async download(
    url: string,
    dest: string,
    hashes: Hashes = {},
    size?: number,
  ): Promise<void> {
    this.downloads.concurrency = this.getConcurrency();
    await this.downloads.downloadVerified({
      url,
      path: dest,
      sha1: hashes.sha1,
      sha256: hashes.sha256,
      sha512: hashes.sha512,
      size,
      maxBytes: MAX_ARCHIVE,
      requireHttps: true,
    });
  }

  private async parallel<T>(
    items: T[],
    work: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    let index = 0;
    const count = Math.min(
      items.length,
      Math.max(1, Math.min(32, Number(this.getConcurrency()) || 6)),
    );
    await Promise.all(
      Array.from({ length: count }, async () => {
        for (;;) {
          const i = index++;
          if (i >= items.length) return;
          await work(items[i], i);
        }
      }),
    );
  }

  async search(input: {
    query: string;
    type: ProjectType;
    version?: string;
    loader?: string;
    offset?: number;
  }): Promise<any> {
    await this.translations.load();
    const queryTranslation =
      input.type === "mod"
        ? this.translations.resolveSearch(input.query || "")
        : {
            originalQuery: input.query || "",
            effectiveQuery: input.query || "",
            translated: false,
          };
    const facets: string[][] = [[`project_type:${input.type}`]];
    if (input.version) facets.push([`versions:${input.version}`]);
    if (input.loader && input.loader !== "vanilla" && input.type === "mod")
      facets.push([`categories:${input.loader}`]);
    const params = new URLSearchParams({
      query: queryTranslation.effectiveQuery.slice(0, 160),
      facets: JSON.stringify(facets),
      limit: "20",
      offset: String(Math.max(0, input.offset || 0)),
      index: input.query ? "relevance" : "downloads",
    });
    const result = await this.request(`/search?${params}`);
    return {
      ...result,
      queryTranslation,
      hits: (result.hits || []).map((hit: any) => ({
        ...hit,
        ...this.translations.localize({
          projectId: hit.project_id,
          slug: input.type === "mod" ? hit.slug : undefined,
          name: hit.title,
          description: hit.description,
        }),
      })),
    };
  }

  async projectVersions(input: {
    projectId: string;
    instance?: Instance;
  }): Promise<any[]> {
    const params = new URLSearchParams();
    if (input.instance) {
      params.set("game_versions", JSON.stringify([input.instance.version]));
      if (input.instance.loader !== "vanilla")
        params.set("loaders", JSON.stringify([input.instance.loader]));
    }
    return this.request(
      `/project/${encodeURIComponent(input.projectId)}/version?${params}`,
    );
  }

  async downloadPack(
    projectId: string,
    versionId?: string,
  ): Promise<{ path: string; meta: any }> {
    const project = await this.request(
      `/project/${encodeURIComponent(projectId)}`,
    );
    if (project.project_type !== "modpack")
      throw new Error("所选项目不是整合包");
    if (typeof project.id !== "string" || !project.id)
      throw new Error("整合包项目信息无效");
    let version: any;
    if (versionId !== undefined) {
      if (typeof versionId !== "string" || !versionId.trim())
        throw new Error("请选择有效的整合包发行版本");
      version = await this.request(`/version/${encodeURIComponent(versionId)}`);
      if (version?.id !== versionId)
        throw new Error("返回的整合包版本与所选版本不一致");
      if (version.project_id !== project.id)
        throw new Error("版本不属于所选整合包项目");
    } else {
      const versions = await this.projectVersions({ projectId });
      version = (Array.isArray(versions) ? versions : [])
        .filter(
          (candidate: any) =>
            candidate?.project_id === project.id &&
            packVersionId(candidate) &&
            packFile(candidate),
        )
        .sort((a: any, b: any) => publishedTime(b) - publishedTime(a))[0];
    }
    if (!version) throw new Error("没有可用的 Modrinth 整合包文件");
    const file = packFile(version);
    if (!packVersionId(version) || !file)
      throw new Error("所选版本没有可用的 Modrinth 整合包文件");
    const dest = path.join(
      this.dataDir,
      "cache",
      "packs",
      `${version.id}-${safeFile(file.filename)}`,
    );
    const taskId = randomUUID();
    this.task(taskId, `下载 ${project.title}`, 0);
    try {
      await this.download(file.url, dest, file.hashes, file.size);
      const meta = await this.inspectPack(dest);
      this.task(taskId, `下载 ${project.title}`, 100, "completed");
      return { path: dest, meta };
    } catch (error: any) {
      this.task(taskId, `下载 ${project.title}`, 0, "error", error.message);
      throw error;
    }
  }

  async packVersions(projectId: string): Promise<ModpackVersion[]> {
    const project = await this.request(
      `/project/${encodeURIComponent(projectId)}`,
    );
    if (project.project_type !== "modpack")
      throw new Error("所选项目不是整合包");
    if (typeof project.id !== "string" || !project.id)
      throw new Error("整合包项目信息无效");
    const versions = await this.projectVersions({ projectId });
    const strings = (value: unknown): string[] =>
      Array.isArray(value)
        ? [
            ...new Set(
              value.filter(
                (item): item is string => typeof item === "string" && !!item,
              ),
            ),
          ]
        : [];
    return (Array.isArray(versions) ? versions : [])
      .filter(
        (version: any) =>
          version?.project_id === project.id &&
          packVersionId(version) &&
          packFile(version),
      )
      .sort((a: any, b: any) => publishedTime(b) - publishedTime(a))
      .map((version: any): ModpackVersion => ({
        id: version.id,
        name: typeof version.name === "string" ? version.name : version.id,
        versionNumber:
          typeof version.version_number === "string"
            ? version.version_number
            : "",
        versionType:
          version.version_type === "beta" || version.version_type === "alpha"
            ? version.version_type
            : "release",
        publishedAt:
          typeof version.date_published === "string"
            ? version.date_published
            : "",
        gameVersions: strings(version.game_versions),
        loaders: strings(version.loaders),
        downloadSize: packFile(version).size ?? 0,
      }));
  }

  async install(
    input: { projectId: string; instance: Instance; versionId?: string },
    skipProjects: Set<string> = new Set(),
  ): Promise<any> {
    await this.translations.load();
    const taskId = randomUUID();
    this.task(taskId, "安装内容", 0);
    const files: string[] = [];
    const dependencies: {
      projectId: string;
      title: string;
      versionId: string;
      version: string;
    }[] = [];
    try {
      type Planned = { project: any; version: any; file: any };
      let order: Planned[] = [];
      let rootProjectId = "";
      let rootProjectType: ProjectType | undefined;
      const projects = new Map<string, any>();
      const releases = new Map<string, any>();
      const lists = new Map<string, any[]>();
      const projectFor = async (id: string) => {
        if (!projects.has(id)) {
          const project = await this.request(
            `/project/${encodeURIComponent(id)}`,
          );
          projects.set(id, project);
          if (project?.id) projects.set(project.id, project);
        }
        return projects.get(id);
      };
      const releaseFor = async (id: string) => {
        if (!releases.has(id))
          releases.set(
            id,
            await this.request(`/version/${encodeURIComponent(id)}`),
          );
        return releases.get(id);
      };
      // Rebuild outgoing edges after an exact requirement replaces an automatic
      // choice. Requirements from the discarded release must disappear as well.
      let selections = new Map<string, string>();
      const seenGraphs = new Set<string>();
      for (let round = 0; ; round++) {
        if (round >= 256)
          throw new Error("必需前置模组版本要求无法收敛，安装已停止");
        const planned = new Map<string, Planned>();
        const pins = new Map<string, Set<string>>();
        let resolutionError: unknown;
        order = [];
        const resolveProject = async (
          projectId: string,
          requestedVersion?: string,
          depth = 0,
        ): Promise<void> => {
          if (skipProjects.has(projectId)) return;
          if (depth > 64)
            throw new Error("必需前置模组依赖过多或过深，安装已停止");
          const project = await projectFor(projectId);
          if (
            !project?.id ||
            !["mod", "modpack", "resourcepack", "shader"].includes(
              project.project_type,
            )
          )
            throw new Error("项目类型或标识无效");
          if (!depth) {
            rootProjectId = project.id;
            rootProjectType = project.project_type;
          }
          if (skipProjects.has(project.id)) return;
          if (
            depth &&
            rootProjectType === "mod" &&
            project.project_type !== "mod"
          )
            throw new Error("必需前置项目不是模组，安装已停止");
          if (requestedVersion) {
            const requirements = pins.get(project.id) || new Set<string>();
            requirements.add(requestedVersion);
            pins.set(project.id, requirements);
          }
          const existing = planned.get(project.id);
          if (existing) return;
          if (planned.size >= 128)
            throw new Error("必需前置模组依赖过多或过深，安装已停止");
          const selectedVersion =
            selections.get(project.id) || requestedVersion;
          if (!selectedVersion && !lists.has(project.id))
            lists.set(
              project.id,
              await this.projectVersions({
                projectId: project.id,
                instance:
                  project.project_type === "mod" ? input.instance : undefined,
              }),
            );
          const versions = selectedVersion
            ? [await releaseFor(selectedVersion)]
            : lists.get(project.id);
          const version = (Array.isArray(versions) ? versions : []).find(
            (v: any) =>
              v?.game_versions?.includes(input.instance.version) &&
              (project.project_type !== "mod" ||
                v.loaders?.includes(input.instance.loader)),
          );
          if (!version)
            throw new Error(
              `${project.title} 没有适用于 Minecraft ${input.instance.version} / ${input.instance.loader} 的版本`,
            );
          if (version.project_id !== project.id)
            throw new Error("版本不属于所选项目");
          if (selectedVersion && version.id !== selectedVersion)
            throw new Error("返回的模组发行版本与所选版本不一致");
          if (
            project.project_type === "mod" &&
            input.instance.loader === "vanilla"
          )
            throw new Error("安装模组需要先创建 Fabric、Quilt 或 Forge 实例");
          const file =
            version.files?.find((f: any) => f.primary) || version.files?.[0];
          if (!file) throw new Error("项目没有可下载文件");
          safeFile(file.filename);
          if (project.project_type === "mod" && !/\.jar$/i.test(file.filename))
            throw new Error("模组发行版没有可安装的 JAR 文件");
          const item = { project, version, file };
          planned.set(project.id, item);
          if (project.project_type !== "modpack") {
            for (const dep of version.dependencies || []) {
              if (dep.dependency_type !== "required") continue;
              try {
                let dependencyProject = dep.project_id;
                if (!dependencyProject && dep.version_id) {
                  const dependencyVersion = await releaseFor(dep.version_id);
                  if (dependencyVersion?.id !== dep.version_id)
                    throw new Error("返回的必需前置版本与要求不一致");
                  dependencyProject = dependencyVersion.project_id;
                }
                if (typeof dependencyProject !== "string" || !dependencyProject)
                  throw new Error("必需前置模组缺少可解析的项目信息");
                await resolveProject(
                  dependencyProject,
                  dep.version_id || undefined,
                  depth + 1,
                );
              } catch (error) {
                // A later pin can discard this entire release and its failed
                // edge. Only errors remaining in the settled graph are fatal.
                resolutionError ||= error;
              }
            }
          }
          order.push(item);
        };
        // Resolve the whole required graph before changing any instance files.
        await resolveProject(input.projectId, input.versionId);
        const next = new Map<string, string>();
        let changed = false;
        let conflict: Planned | undefined;
        for (const [id, item] of planned) {
          const requirements = pins.get(id);
          const selected =
            requirements?.size === 1 ? [...requirements][0] : item.version.id;
          next.set(id, selected);
          if (selected !== item.version.id) changed = true;
          if (requirements && requirements.size > 1) conflict = item;
        }
        for (const [id, requirements] of pins) {
          if (planned.has(id) || requirements.size !== 1) continue;
          const selected = [...requirements][0];
          next.set(id, selected);
          if (selections.get(id) !== selected) changed = true;
        }
        if (!changed) {
          if (conflict)
            throw new Error(
              `${conflict.project.title} 的必需前置版本要求冲突，安装已停止`,
            );
          if (resolutionError) throw resolutionError;
          break;
        }
        const state = JSON.stringify(
          [...next].sort(([a], [b]) => a.localeCompare(b)),
        );
        if (seenGraphs.has(state))
          throw new Error("必需前置模组版本要求存在循环冲突，安装已停止");
        seenGraphs.add(state);
        selections = next;
      }
      const installProject = async ({
        project,
        version,
        file,
      }: Planned): Promise<any> => {
        if (project.project_type === "modpack") {
          const packed = path.join(
            this.dataDir,
            "cache",
            "packs",
            safeFile(file.filename),
          );
          await this.download(file.url, packed, file.hashes, file.size);
          const result = await this.importPack(packed, input.instance);
          files.push(...result.files);
          return result;
        }
        const dir =
          project.project_type === "resourcepack"
            ? "resourcepacks"
            : project.project_type === "shader"
              ? "shaderpacks"
              : "mods";
        const meta = await this.metadata(input.instance);
        let filename = safeFile(file.filename);
        const earlier = new Set(
          Object.entries(meta)
            .filter(
              ([key, value]) =>
                key.startsWith(`${dir}/`) && value.projectId === project.id,
            )
            .map(([key]) => key),
        );
        const localSources = new Set<string>();
        let disabled = false;
        // Required dependencies must be enabled even when an earlier copy was disabled.
        if (dir === "mods" && project.id === rootProjectId)
          for (const key of earlier)
            if (
              !(await exists(
                path.join(this.instanceDir(input.instance), key),
              )) &&
              (await exists(
                path.join(this.instanceDir(input.instance), `${key}.disabled`),
              ))
            )
              disabled = true;
        const staged = path.join(
          this.dataDir,
          "cache",
          "content",
          `${randomUUID()}-${filename}`,
        );
        if (dir === "mods" && project.id !== rootProjectId) {
          const local = await this.listMods(input.instance);
          const sameFile = (mod: ModInfo) => {
            const sha512 = file.hashes?.sha512;
            if (typeof sha512 === "string" && /^[a-f0-9]{128}$/i.test(sha512))
              return mod.sha512 === sha512.toLowerCase();
            const sha1 = file.hashes?.sha1;
            return (
              typeof sha1 === "string" &&
              /^[a-f0-9]{40}$/i.test(sha1) &&
              mod.sha1 === sha1.toLowerCase()
            );
          };
          const exact = local.filter(sameFile);
          const reuse = exact.find((mod) => mod.enabled) || exact[0];
          if (reuse) {
            filename = safeFile(reuse.file.replace(/\.disabled$/i, ""));
            await fs.mkdir(path.dirname(staged), { recursive: true });
            await fs.copyFile(
              path.join(this.instanceDir(input.instance), "mods", reuse.file),
              staged,
            );
          } else {
            await this.download(file.url, staged, file.hashes, file.size);
          }
          try {
            let targetIds = reuse?.ids || [];
            if (!reuse) {
              try {
                const zip = new AdmZip(staged);
                targetIds = readModMetadata((name) => {
                  const entry = zip.getEntry(name);
                  return entry && entry.header.size < 4 * 1024 * 1024
                    ? entry.getData().toString("utf8")
                    : null;
                }, project.title).ids;
              } catch {}
            }
            const confirmed = new Set(exact.map((mod) => mod.file));
            for (const mod of local)
              if (mod.projectId === project.id) confirmed.add(mod.file);
            const unknown = local.filter(
              (mod) =>
                !confirmed.has(mod.file) &&
                mod.ids.some((id) => targetIds.includes(id)),
            );
            // A mod ID alone is not proof of project ownership. Require the
            // service's exact hash identity before replacing imported files.
            for (let start = 0; start < unknown.length; start += 100) {
              const chunk = unknown.slice(start, start + 100);
              const identities = await this.request("/version_files", {
                method: "POST",
                body: JSON.stringify({
                  hashes: chunk.map((mod) => mod.sha512),
                  algorithm: "sha512",
                }),
              });
              for (const mod of chunk) {
                const identity = identities?.[mod.sha512];
                if (
                  identity?.project_id === project.id &&
                  identity.files?.some(
                    (candidate: any) =>
                      typeof candidate.hashes?.sha512 === "string" &&
                      candidate.hashes.sha512.toLowerCase() === mod.sha512,
                  )
                )
                  confirmed.add(mod.file);
              }
            }
            const conflict = local.find(
              (mod) =>
                !confirmed.has(mod.file) &&
                (mod.file.replace(/\.disabled$/i, "").toLowerCase() ===
                  filename.toLowerCase() ||
                  (mod.enabled &&
                    mod.ids.some((id) => targetIds.includes(id)))),
            );
            if (conflict)
              throw new Error(
                `已有模组 ${conflict.file} 与必需前置冲突且无法确认项目身份，请先处理该文件`,
              );
            for (const mod of local)
              if (confirmed.has(mod.file)) {
                earlier.add(`mods/${mod.file.replace(/\.disabled$/i, "")}`);
                localSources.add(`mods/${mod.file}`);
              }
          } catch (error) {
            await fs.rm(staged, { force: true });
            throw error;
          }
        } else {
          await this.download(file.url, staged, file.hashes, file.size);
        }
        const installedName = filename + (disabled ? ".disabled" : "");
        const dest = path.join(
          this.instanceDir(input.instance),
          dir,
          installedName,
        );
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const displaced: { source: string; backup: string }[] = [];
        try {
          const sources = new Set([
            ...[...earlier, `${dir}/${filename}`].flatMap((old) => [
              old,
              ...(dir === "mods" ? [`${old}.disabled`] : []),
            ]),
            ...localSources,
          ]);
          for (const old of sources) {
            const source = inside(this.instanceDir(input.instance), old);
            if (!(await exists(source))) continue;
            const backup = inside(
              path.join(this.instanceDir(input.instance), ".trash", taskId),
              old,
            );
            await fs.mkdir(path.dirname(backup), { recursive: true });
            await fs.rename(source, backup);
            displaced.push({ source, backup });
          }
          await fs.rename(staged, dest);
        } catch (error) {
          for (const previous of displaced.reverse())
            await fs.rename(previous.backup, previous.source);
          throw error;
        } finally {
          await fs.rm(staged, { force: true });
        }
        for (const old of earlier) delete meta[old];
        meta[`${dir}/${filename}`] = {
          projectId: project.id,
          versionId: version.id,
          versionName: version.version_number,
        };
        await this.saveMetadata(input.instance, meta);
        files.push(`${dir}/${installedName}`);
        if (project.id !== rootProjectId)
          dependencies.push({
            projectId: project.id,
            title: project.title,
            versionId: version.id,
            version: version.version_number,
          });
        return {
          project: project.title,
          projectId: project.id,
          version: version.version_number,
          ...this.translations.localize({
            projectId: project.id,
            slug: project.project_type === "mod" ? project.slug : undefined,
            name: project.title,
            description: project.description,
          }),
        };
      };
      let result: any;
      for (const item of order) {
        const installed = await installProject(item);
        if (item.project.id === rootProjectId) result = installed;
      }
      this.task(taskId, "内容安装完成", 100, "completed");
      return { ...result, files, dependencies };
    } catch (error: any) {
      this.task(taskId, "内容安装失败", 0, "error", error.message);
      throw error;
    }
  }

  private async readPack(
    filePath: string,
  ): Promise<{ zip: AdmZip; index: any }> {
    const info = await fs.stat(filePath);
    if (info.size > MAX_ARCHIVE)
      throw new Error("整合包文件过大（最大 1 GiB）");
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    if (
      entries.length > 100000 ||
      entries.reduce((n, e) => n + e.header.size, 0) > MAX_EXPANDED
    )
      throw new Error("整合包解压大小超过限制");
    const indexEntry = zip.getEntry("modrinth.index.json");
    if (!indexEntry || indexEntry.header.size > 8 * 1024 * 1024)
      throw new Error("请选择有效的 Modrinth .mrpack 整合包");
    const index = JSON.parse(indexEntry.getData().toString("utf8"));
    if (
      index.game !== "minecraft" ||
      index.formatVersion !== 1 ||
      !index.dependencies?.minecraft ||
      !Array.isArray(index.files)
    )
      throw new Error("整合包清单格式不受支持");
    return { zip, index };
  }

  async inspectPack(filePath: string): Promise<any> {
    const { index } = await this.readPack(filePath);
    const deps = index.dependencies;
    const loader = deps["fabric-loader"]
      ? "fabric"
      : deps["quilt-loader"]
        ? "quilt"
        : deps.forge
          ? "forge"
          : deps.neoforge
            ? "neoforge"
            : "vanilla";
    return {
      name: index.name || path.basename(filePath),
      minecraftVersion: deps.minecraft,
      loader,
      loaderVersion:
        deps["fabric-loader"] ||
        deps["quilt-loader"] ||
        deps.forge ||
        deps.neoforge,
      formatVersion: index.formatVersion,
    };
  }

  async importPack(filePath: string, instance: Instance): Promise<any> {
    const taskId = randomUUID();
    const title = "导入整合包";
    this.task(taskId, title, 0);
    const staging = path.join(this.dataDir, "cache", "pack-staging", taskId);
    try {
      const { zip, index } = await this.readPack(filePath);
      const info = await this.inspectPack(filePath);
      if (
        instance.version !== info.minecraftVersion ||
        instance.loader !== info.loader ||
        (info.loaderVersion && instance.loaderVersion !== info.loaderVersion)
      )
        throw new Error(
          `整合包需要 Minecraft ${info.minecraftVersion} / ${info.loader} ${info.loaderVersion || ""}。请创建匹配实例后导入。`,
        );
      await fs.mkdir(staging, { recursive: true });
      const candidates = index.files.filter(
        (f: any) => f.env?.client !== "unsupported",
      );
      if (candidates.length > 30000) throw new Error("整合包文件数量超过限制");
      const seen = new Set<string>();
      let completed = 0;
      await this.parallel(candidates, async (file: any) => {
        if (
          !Array.isArray(file.downloads) ||
          !file.downloads.length ||
          !(file.hashes?.sha1 || file.hashes?.sha512)
        )
          throw new Error("整合包存在缺少下载地址或校验值的文件");
        const dest = inside(staging, file.path);
        const key = dest.toLowerCase();
        if (seen.has(key)) throw new Error("整合包包含重复文件路径");
        seen.add(key);
        this.assertPackPath(file.path, instance);
        let last: unknown;
        for (const url of file.downloads) {
          try {
            await this.download(url, dest, file.hashes, file.fileSize);
            last = undefined;
            break;
          } catch (error) {
            last = error;
          }
        }
        if (last) throw last;
        this.task(
          taskId,
          title,
          (++completed / Math.max(1, candidates.length)) * 85,
          "running",
          file.path,
        );
      });
      for (const prefix of ["overrides/", "client-overrides/"]) {
        for (const entry of zip
          .getEntries()
          .filter((e) => e.entryName.startsWith(prefix) && !e.isDirectory)) {
          if (((entry.header.attr >>> 16) & 0xf000) === 0xa000)
            throw new Error("整合包不允许符号链接");
          const relative = entry.entryName.slice(prefix.length);
          const dest = inside(staging, relative);
          this.assertPackPath(relative, instance);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, entry.getData());
        }
      }
      const files: string[] = [];
      // Check once after staging and before the first publish: a nested link in
      // config/saves must never redirect a relative override outside this version.
      await assertPlainTree(this.instanceDir(instance));
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const source = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(source);
          else {
            const relative = path.relative(staging, source);
            const dest = inside(this.instanceDir(instance), relative);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            if (await exists(dest)) {
              const backup = inside(
                path.join(this.instanceDir(instance), ".trash", taskId),
                relative,
              );
              await fs.mkdir(path.dirname(backup), { recursive: true });
              await fs.rename(dest, backup);
            }
            await fs.rename(source, dest);
            files.push(relative.replace(/\\/g, "/"));
          }
        }
      };
      await walk(staging);
      this.task(taskId, title, 100, "completed");
      return {
        ...info,
        files,
        optionalFilesIncluded: candidates.filter(
          (f: any) => f.env?.client === "optional",
        ).length,
      };
    } catch (error: any) {
      this.task(taskId, title, 0, "error", error.message);
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async importMods(paths: string[], instance: Instance): Promise<any> {
    if (instance.loader === "vanilla")
      throw new Error("请先创建模组加载器实例");
    const dest = path.join(this.instanceDir(instance), "mods");
    await fs.mkdir(dest, { recursive: true });
    const files: string[] = [];
    for (const source of paths) {
      const name = safeFile(path.basename(source));
      if (!/\.jar$/i.test(name)) throw new Error("模组文件必须为 .jar");
      const stat = await fs.stat(source);
      if (stat.size > MAX_ARCHIVE) throw new Error("模组文件过大");
      const target = path.join(dest, name);
      if (path.resolve(source) !== path.resolve(target)) {
        if (await exists(target))
          throw new Error(`${name} 已存在，请先移除旧文件`);
        await fs.copyFile(source, target, 1);
      }
      files.push(name);
    }
    return { files };
  }

  async listFiles(
    instance: Instance,
    kind: "resourcepack" | "shader",
  ): Promise<any[]> {
    const dir = path.join(
      this.instanceDir(instance),
      kind === "resourcepack" ? "resourcepacks" : "shaderpacks",
    );
    await fs.mkdir(dir, { recursive: true });
    const result = [];
    for (const item of await fs.readdir(dir, { withFileTypes: true }))
      if (item.isFile()) {
        const stat = await fs.stat(path.join(dir, item.name));
        result.push({ file: item.name, size: stat.size });
      }
    return result;
  }

  async importFiles(
    paths: string[],
    instance: Instance,
    kind: "resourcepack" | "shader",
  ): Promise<any> {
    const dir = path.join(
      this.instanceDir(instance),
      kind === "resourcepack" ? "resourcepacks" : "shaderpacks",
    );
    await fs.mkdir(dir, { recursive: true });
    const files = [];
    for (const source of paths) {
      const name = safeFile(path.basename(source));
      if (!/\.zip$/i.test(name)) throw new Error("资源包和光影包必须为 .zip");
      await fs.copyFile(source, path.join(dir, name), 1);
      files.push(name);
    }
    return { files };
  }

  async listMods(instance: Instance): Promise<ModInfo[]> {
    await this.translations.load();
    const dir = path.join(this.instanceDir(instance), "mods");
    await fs.mkdir(dir, { recursive: true });
    const meta = await this.metadata(instance);
    const files = (await fs.readdir(dir, { withFileTypes: true }))
      .filter(
        (entry) => entry.isFile() && /\.jar(?:\.disabled)?$/i.test(entry.name),
      )
      .map((entry) => entry.name);
    const result: ModInfo[] = [];
    await this.parallel(files, async (file) => {
      const full = path.join(dir, file),
        stat = await fs.stat(full);
      const hashes = await digest(full);
      const mod: ModInfo = {
        file,
        name: file.replace(/\.jar(?:\.disabled)?$/i, ""),
        id: "",
        ids: [],
        version: "",
        description: "",
        enabled: !/\.disabled$/i.test(file),
        size: stat.size,
        sha512: hashes.sha512!,
        sha1: hashes.sha1!,
        projectId: meta[`mods/${file.replace(/\.disabled$/i, "")}`]?.projectId,
      };
      try {
        if (stat.size > MAX_ARCHIVE) throw new Error("文件过大");
        const zip = new AdmZip(full);
        const read = (name: string) => {
          const e = zip.getEntry(name);
          return e && e.header.size < 4 * 1024 * 1024
            ? e.getData().toString("utf8")
            : null;
        };
        Object.assign(mod, readModMetadata(read, mod.name));
      } catch {
        mod.description ||= "无法读取模组元数据，仍按文件哈希检测重复";
      }
      Object.assign(
        mod,
        this.translations.localize({
          projectId: mod.projectId,
          modIds: mod.ids,
          name: mod.name,
          description: mod.description,
        }),
      );
      result.push(mod);
    });
    const duplicates = new Set(
      findDuplicateMods(result).flatMap((group) => group.files),
    );
    for (const mod of result) mod.duplicate = duplicates.has(mod.file);
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async scanDuplicates(instance: Instance): Promise<any[]> {
    return findDuplicateMods(await this.listMods(instance));
  }

  async enableMod(
    instance: Instance,
    file: string,
    enabled: boolean,
  ): Promise<void> {
    safeFile(file);
    if (!/\.jar(?:\.disabled)?$/i.test(file)) throw new Error("无效模组文件");
    const name = enabled
      ? file.replace(/\.disabled$/i, "")
      : /\.disabled$/i.test(file)
        ? file
        : `${file}.disabled`;
    if (file === name) return;
    const dir = path.join(this.instanceDir(instance), "mods");
    if (await exists(path.join(dir, name)))
      throw new Error("目标模组文件已存在");
    await fs.rename(path.join(dir, file), path.join(dir, name));
  }

  async removeMod(instance: Instance, file: string): Promise<void> {
    safeFile(file);
    if (!/\.jar(?:\.disabled)?$/i.test(file)) throw new Error("无效模组文件");
    const trash = path.join(this.instanceDir(instance), ".trash", randomUUID());
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(
      path.join(this.instanceDir(instance), "mods", file),
      path.join(trash, file),
    );
  }

  async checkUpdates(instance: Instance): Promise<any[]> {
    const mods = await this.listMods(instance);
    if (!mods.length || instance.loader === "vanilla") return [];
    const updates: any[] = [];
    for (let start = 0; start < mods.length; start += 100) {
      const chunk = mods.slice(start, start + 100);
      const response = await this.request("/version_files/update", {
        method: "POST",
        body: JSON.stringify({
          hashes: chunk.map((m) => m.sha512),
          algorithm: "sha512",
          loaders: [instance.loader],
          game_versions: [instance.version],
        }),
      });
      for (const mod of chunk) {
        const version = response[mod.sha512];
        if (!version) continue;
        const file =
          version.files?.find((f: any) => f.primary) || version.files?.[0];
        if (file && file.hashes?.sha512 !== mod.sha512)
          updates.push({
            file: mod.file,
            name: mod.name,
            from: mod.version,
            to: version.version_number,
            versionId: version.id,
            projectId: version.project_id,
            enabled: mod.enabled,
            oldHash: mod.sha512,
            download: file,
          });
      }
    }
    return updates;
  }

  async applyUpdates(instance: Instance, updates: any[]): Promise<any> {
    const taskId = randomUUID(),
      files: string[] = [];
    const stage = path.join(this.dataDir, "cache", "updates", taskId);
    await fs.mkdir(stage, { recursive: true });
    this.task(taskId, "更新模组", 0);
    try {
      // Re-query versions from the service: renderer-supplied URLs and hashes are never trusted.
      const current = await this.listMods(instance);
      let done = 0;
      const validated: {
        mod: ModInfo;
        version: any;
        file: any;
        temp: string;
      }[] = [];
      const requested = new Set<string>();
      for (const update of updates.slice(0, 500)) {
        if (requested.has(update.file)) continue;
        requested.add(update.file);
        const mod = current.find(
          (m) => m.file === update.file && m.sha512 === update.oldHash,
        );
        if (!mod) throw new Error("模组文件已改变，请重新检查更新");
        const version = await this.request(
          `/version/${encodeURIComponent(update.versionId)}`,
        );
        if (
          !version.loaders?.includes(instance.loader) ||
          !version.game_versions?.includes(instance.version)
        )
          throw new Error("更新版本与实例不兼容");
        const file =
          version.files?.find((f: any) => f.primary) || version.files?.[0];
        if (!file?.hashes?.sha512) throw new Error("更新文件缺少校验值");
        const filename = safeFile(file.filename);
        const temp = path.join(stage, `${validated.length}-${filename}`);
        await this.download(file.url, temp, file.hashes, file.size);
        validated.push({ mod, version, file, temp });
        this.task(
          taskId,
          "更新模组",
          (++done / Math.max(1, updates.length)) * 85,
          "running",
          mod.name,
        );
      }
      // Dependencies introduced by a new release must be available before its jar replaces the old one.
      const targets = new Map(
        validated.map((item) => [item.version.project_id, item.version.id]),
      );
      const installedDependencies = new Set<string>();
      for (const item of validated) {
        for (const dependency of item.version.dependencies || []) {
          if (dependency.dependency_type !== "required") continue;
          let projectId = dependency.project_id;
          if (!projectId && dependency.version_id)
            projectId = (
              await this.request(
                `/version/${encodeURIComponent(dependency.version_id)}`,
              )
            ).project_id;
          if (!projectId) continue;
          if (targets.has(projectId)) {
            if (
              dependency.version_id &&
              targets.get(projectId) !== dependency.version_id
            )
              throw new Error("所选模组更新之间存在依赖版本冲突，请分别更新");
            continue;
          }
          const key = `${projectId}:${dependency.version_id || "latest"}`;
          if (installedDependencies.has(key)) continue;
          await this.install(
            {
              projectId,
              instance,
              versionId: dependency.version_id || undefined,
            },
            new Set(targets.keys()),
          );
          installedDependencies.add(key);
        }
      }
      const meta = await this.metadata(instance),
        modsDir = path.join(this.instanceDir(instance), "mods");
      for (const item of validated) {
        const filename =
          safeFile(item.file.filename) + (item.mod.enabled ? "" : ".disabled");
        const oldPath = path.join(modsDir, item.mod.file),
          newPath = path.join(modsDir, filename);
        if (newPath !== oldPath && (await exists(newPath)))
          throw new Error(`${filename} 已存在，更新已停止`);
        if ((await digest(oldPath)).sha512 !== item.mod.sha512)
          throw new Error("模组文件已改变，更新已停止");
        const backup = path.join(
          this.instanceDir(instance),
          ".trash",
          taskId,
          item.mod.file,
        );
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.rename(oldPath, backup);
        try {
          await fs.rename(item.temp, newPath);
        } catch (error) {
          await fs.rename(backup, oldPath);
          throw error;
        }
        delete meta[`mods/${item.mod.file.replace(/\.disabled$/i, "")}`];
        meta[`mods/${filename.replace(/\.disabled$/i, "")}`] = {
          projectId: item.version.project_id,
          versionId: item.version.id,
          versionName: item.version.version_number,
        };
        files.push(filename);
      }
      await this.saveMetadata(instance, meta);
      this.task(taskId, "模组更新完成", 100, "completed");
      return { files };
    } catch (error: any) {
      this.task(taskId, "模组更新失败", 0, "error", error.message);
      throw error;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }
}

export const contentSafety = { safeFile, inside };
