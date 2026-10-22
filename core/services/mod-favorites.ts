import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FavoriteMod } from "../../shared/types";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 1000;
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(value))
    throw new Error("模组收藏项目标识无效");
  return value;
}
function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : undefined;
}
function favorite(value: any): FavoriteMod {
  const projectId = identifier(value?.projectId);
  const slug = identifier(value?.slug);
  const title = text(value?.title, 300);
  if (!title) throw new Error("模组收藏缺少项目名称");
  let iconUrl: string | undefined;
  if (typeof value.iconUrl === "string" && value.iconUrl.length <= 2048) {
    try {
      if (new URL(value.iconUrl).protocol === "https:") iconUrl = value.iconUrl;
    } catch {}
  }
  return {
    projectId,
    slug,
    title,
    ...(text(value.displayName, 300)
      ? { displayName: text(value.displayName, 300) }
      : {}),
    ...(text(value.description, 6000)
      ? { description: text(value.description, 6000) }
      : {}),
    ...(text(value.author, 300) ? { author: text(value.author, 300) } : {}),
    ...(iconUrl ? { iconUrl } : {}),
  };
}

export class ModFavorites {
  private pending: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "mod-favorites.json");
  }
  private async read(): Promise<FavoriteMod[]> {
    let stat;
    try {
      stat = await fs.lstat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("模组收藏文件不是有效的普通配置文件");
    const value = JSON.parse(await fs.readFile(this.file, "utf8"));
    if (
      !value ||
      value.formatVersion !== 1 ||
      !Array.isArray(value.mods) ||
      value.mods.length > MAX_ITEMS
    )
      throw new Error("模组收藏配置格式无效");
    const mods = value.mods.map(favorite);
    if (
      new Set(mods.map((mod: FavoriteMod) => mod.projectId)).size !==
      mods.length
    )
      throw new Error("模组收藏配置包含重复项目");
    return mods;
  }
  async list(): Promise<FavoriteMod[]> {
    await this.pending.catch(() => {});
    return this.read();
  }
  async set(project: any, saved: boolean): Promise<FavoriteMod[]> {
    if (typeof saved !== "boolean") throw new Error("模组收藏状态无效");
    const projectId = identifier(project?.projectId);
    const selected = saved ? favorite(project) : undefined;
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        const current = await this.read();
        const mods = current.filter((mod) => mod.projectId !== projectId);
        if (selected) mods.unshift(selected);
        if (mods.length > MAX_ITEMS) throw new Error("最多可收藏 1000 个模组");
        const bytes = Buffer.from(
          JSON.stringify({ formatVersion: 1, mods }, null, 2),
        );
        if (bytes.length > MAX_BYTES)
          throw new Error("模组收藏配置超过大小限制");
        await fs.mkdir(this.dataDir, { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
          await fs.rename(temporary, this.file);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        return mods;
      });
    this.pending = operation;
    return operation;
  }
}
