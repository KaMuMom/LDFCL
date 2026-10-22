import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import type { Instance } from "../../shared/types";
import {
  assertInstanceGameDirectory,
  assertPlainTree,
} from "../instance-paths";
import { withDestination } from "./download-queue";
import { replaceStorageFile } from "./content-store";

export type PackKind = "resourcepack" | "shader";
export type ShaderRenderer = "iris" | "oculus" | "optifine";
export interface InstalledPack {
  name: string;
  size: number;
  enabled: boolean;
  order: number;
  description?: string;
}
function kindDirectory(kind: PackKind): string {
  if (kind !== "resourcepack" && kind !== "shader")
    throw new Error("无效的内容类型");
  return kind === "resourcepack" ? "resourcepacks" : "shaderpacks";
}
function packName(name: string): string {
  if (
    typeof name !== "string" ||
    name !== path.basename(name) ||
    /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ||
    !/\.zip$/i.test(name) ||
    name.length > 220
  )
    throw new Error("无效的资源包文件名");
  return name;
}
async function textFile(filename: string): Promise<string> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw new Error("设置文件不是安全的普通文件");
    return await fs.readFile(filename, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
function property(
  text: string,
  key: string,
  separator: ":" | "=",
): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith(key + separator));
  const raw = lines
    .at(-1)
    ?.slice(key.length + 1)
    .trim();
  return separator === "="
    ? raw?.replace(/\\u([0-9a-f]{4})|\\(.)/gi, (_all, unicode, escaped) =>
        unicode
          ? String.fromCharCode(parseInt(unicode, 16))
          : { n: "\n", r: "\r", t: "\t" }[escaped as string] || escaped,
      )
    : raw;
}
function editProperties(
  text: string,
  values: Record<string, string>,
  separator: ":" | "=",
): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !Object.keys(values).some((key) => line.startsWith(key + separator)),
    );
  while (lines.at(-1) === "") lines.pop();
  const encoded = (value: string) =>
    separator === "="
      ? value
          .replace(/\\/g, "\\\\")
          .replace(
            /[^\x20-\x7e]/g,
            (character) =>
              `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
          )
      : value;
  return [
    ...lines,
    ...Object.entries(values).map(
      ([key, value]) => `${key}${separator}${encoded(value)}`,
    ),
    "",
  ].join(newline);
}
function resourceSelection(text: string): string[] {
  const raw = property(text, "resourcePacks", ":");
  if (raw === undefined) return ["vanilla"];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("options.txt 中的资源包列表无效，请先修复后再管理");
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("资源包列表格式无效");
  return value;
}
async function atomicText(filename: string, content: string): Promise<void> {
  await textFile(filename);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const parent = await fs.lstat(path.dirname(filename));
  if (parent.isSymbolicLink() || !parent.isDirectory())
    throw new Error("设置目录不是安全的普通文件夹");
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { flag: "wx" });
    await replaceStorageFile(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
function shaderConfig(root: string, renderer: ShaderRenderer): string {
  return renderer === "optifine"
    ? path.join(root, "optionsshaders.txt")
    : path.join(root, "config", `${renderer}.properties`);
}

/** Manages actual Minecraft/Iris/Oculus/OptiFine selections, never a synthetic shaderpacks option. */
export class ContentPacksService {
  constructor(private minecraftRoot: string) {}
  private async root(instance: Instance): Promise<string> {
    return assertInstanceGameDirectory(this.minecraftRoot, instance);
  }
  private async renderer(
    root: string,
    instance: Instance,
  ): Promise<ShaderRenderer | undefined> {
    if (instance.loader === "optifine") return "optifine";
    const mods = path.join(root, "mods");
    try {
      await assertPlainTree(mods);
      for (const filename of await fs.readdir(mods)) {
        if (!/\.jar$/i.test(filename)) continue;
        try {
          const archive = new AdmZip(path.join(mods, filename));
          const fabric = archive.getEntry("fabric.mod.json");
          if (
            fabric &&
            fabric.header.size < 1024 * 1024 &&
            JSON.parse(fabric.getData().toString("utf8")).id === "iris"
          )
            return "iris";
          for (const metadata of [
            "META-INF/mods.toml",
            "META-INF/neoforge.mods.toml",
          ]) {
            const entry = archive.getEntry(metadata);
            if (
              entry &&
              entry.header.size < 1024 * 1024 &&
              /modId\s*=\s*["']oculus["']/.test(
                entry.getData().toString("utf8"),
              )
            )
              return "oculus";
          }
          if (archive.getEntry("optifine/Installer.class")) return "optifine";
        } catch {
          /* An unrelated invalid mod must not hide the installed pack list. */
        }
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    return undefined;
  }
  async list(
    instance: Instance,
    kind: PackKind,
  ): Promise<{
    packs: InstalledPack[];
    renderer?: ShaderRenderer;
    shaderAvailable: boolean;
  }> {
    const root = await this.root(instance),
      directory = path.join(root, kindDirectory(kind));
    await fs.mkdir(directory, { recursive: true });
    await assertPlainTree(directory);
    const renderer = await this.renderer(root, instance);
    const options =
      kind === "resourcepack"
        ? resourceSelection(await textFile(path.join(root, "options.txt")))
        : [];
    const shaderText = renderer
      ? await textFile(shaderConfig(root, renderer))
      : "";
    const selectedShader = property(shaderText, "shaderPack", "=");
    const shadersEnabled =
      renderer === "optifine" ||
      property(shaderText, "enableShaders", "=") !== "false";
    const packs: InstalledPack[] = [];
    for (const name of await fs.readdir(directory)) {
      if (!/\.zip$/i.test(name)) continue;
      const stat = await fs.lstat(path.join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const index = options.indexOf(`file/${name}`);
      packs.push({
        name,
        size: stat.size,
        enabled:
          kind === "resourcepack"
            ? index >= 0
            : !!renderer && shadersEnabled && selectedShader === name,
        order: index,
      });
    }
    return {
      packs: packs.sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) ||
          (a.enabled && b.enabled
            ? a.order - b.order
            : a.name.localeCompare(b.name)),
      ),
      renderer,
      shaderAvailable: !!renderer,
    };
  }
  async setEnabled(
    instance: Instance,
    kind: PackKind,
    name: string,
    enabled: boolean,
  ): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("启用状态必须为开关值");
    name = packName(name);
    const root = await this.root(instance);
    const file = path.join(root, kindDirectory(kind), name);
    await assertPlainTree(file);
    if (!(await fs.lstat(file)).isFile()) throw new Error("资源包不是普通文件");
    if (kind === "resourcepack") {
      const options = path.join(root, "options.txt");
      await withDestination(options, async () => {
        const text = await textFile(options),
          selection = resourceSelection(text).filter(
            (item) => item !== `file/${name}`,
          );
        if (enabled) selection.push(`file/${name}`);
        await atomicText(
          options,
          editProperties(
            text,
            { resourcePacks: JSON.stringify(selection) },
            ":",
          ),
        );
      });
    } else {
      const renderer = await this.renderer(root, instance);
      if (!renderer) {
        if (enabled)
          throw new Error(
            "此实例尚未安装 Iris、Oculus 或 OptiFine，无法启用光影",
          );
        return;
      }
      const config = shaderConfig(root, renderer);
      await withDestination(config, async () => {
        const text = await textFile(config);
        if (!enabled && property(text, "shaderPack", "=") !== name) return;
        const values: Record<string, string> =
          renderer === "optifine"
            ? { shaderPack: enabled ? name : "OFF" }
            : {
                shaderPack: enabled ? name : "",
                enableShaders: String(enabled),
              };
        await atomicText(config, editProperties(text, values, "="));
      });
    }
  }
  async reorder(instance: Instance, names: string[]): Promise<void> {
    if (!Array.isArray(names) || new Set(names).size !== names.length)
      throw new Error("资源包顺序无效");
    const root = await this.root(instance),
      options = path.join(root, "options.txt");
    for (const name of names) {
      packName(name);
      await assertPlainTree(path.join(root, "resourcepacks", name));
    }
    await withDestination(options, async () => {
      const text = await textFile(options),
        current = resourceSelection(text);
      const managed = new Set(names.map((name) => `file/${name}`));
      if (names.some((name) => !current.includes(`file/${name}`)))
        throw new Error("只能排序已启用的资源包");
      const preserved = current.filter((name) => !managed.has(name));
      await atomicText(
        options,
        editProperties(
          text,
          { resourcePacks: JSON.stringify([...preserved, ...managed]) },
          ":",
        ),
      );
    });
  }
  async remove(
    instance: Instance,
    kind: PackKind,
    name: string,
  ): Promise<void> {
    await this.setEnabled(instance, kind, name, false);
    const root = await this.root(instance);
    const trash = path.join(root, ".trash");
    await fs.mkdir(trash, { recursive: true });
    await assertPlainTree(trash);
    await fs.rename(
      path.join(root, kindDirectory(kind), packName(name)),
      path.join(trash, `${Date.now()}-${randomUUID()}-${name}`),
    );
  }
}
