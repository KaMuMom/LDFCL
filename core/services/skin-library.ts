import path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { SkinLibraryEntry } from "../../shared/types";
import { validateSkinPng } from "./accounts";

const MAX_SKIN_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 256;
const MAX_INDEX_BYTES = 256 * 1024;
const PREFIX = "data:image/png;base64,";
type RecordEntry = Omit<SkinLibraryEntry, "dataUrl">;

function nameOf(value: unknown): string {
  if (typeof value !== "string") throw Error("请输入皮肤名称。");
  const name = value.trim();
  if (!name || [...name].length > 80 || /[\u0000-\u001f\u007f]/.test(name))
    throw Error("皮肤名称需要 1–80 个字符，且不能包含控制字符。");
  return name;
}

function idOf(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
  )
    throw Error("皮肤标识无效。");
  return value;
}

function variantOf(value: unknown): "classic" | "slim" {
  if (value !== "classic" && value !== "slim")
    throw Error("请选择经典或纤细皮肤模型。");
  return value;
}

function validateLibraryPng(data: Buffer): void {
  validateSkinPng(data);
  const invalid = () => new Error("皮肤 PNG 文件损坏，无法读取像素。");
  const crc32 = (buffer: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  let offset = 8,
    header: Buffer | undefined,
    ended = false,
    palette = false;
  const compressed: Buffer[] = [];
  while (offset < data.length) {
    if (offset + 12 > data.length) throw invalid();
    const length = data.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > data.length) throw invalid();
    const name = data.toString("ascii", offset + 4, offset + 8);
    if (
      crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)
    )
      throw invalid();
    const content = data.subarray(offset + 8, end - 4);
    if (!header && name !== "IHDR") throw invalid();
    if (name === "IHDR") {
      if (header || length !== 13) throw invalid();
      header = content;
    } else if (name === "IDAT") compressed.push(content);
    else if (name === "PLTE") {
      if (!length || length > 768 || length % 3) throw invalid();
      palette = true;
    } else if (name === "IEND") {
      if (length || end !== data.length) throw invalid();
      ended = true;
    }
    offset = end;
  }
  if (!header || !ended || !compressed.length) throw invalid();
  const depth = header[8],
    color = header[9],
    interlaced = header[12];
  const depths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !depths[color]?.includes(depth) ||
    header[10] ||
    header[11] ||
    interlaced > 1 ||
    (color === 3 && !palette)
  )
    throw invalid();
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[
    color
  ];
  const width = header.readUInt32BE(0),
    height = header.readUInt32BE(4);
  const passes = interlaced
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const scanlines: number[] = [];
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.ceil((width - x) / dx),
      rows = Math.ceil((height - y) / dy);
    if (columns > 0 && rows > 0)
      for (let row = 0; row < rows; row++)
        scanlines.push(Math.ceil((columns * channels * depth) / 8));
  }
  const expected = scanlines.reduce((total, length) => total + length + 1, 0);
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: expected + 1,
    });
  } catch {
    throw invalid();
  }
  if (pixels.length !== expected) throw invalid();
  let position = 0;
  for (const length of scanlines) {
    if (pixels[position] > 4) throw invalid();
    position += length + 1;
  }
}

export function decodeLibrarySkin(dataUrl: unknown): Buffer {
  if (
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith(PREFIX) ||
    dataUrl.length > PREFIX.length + Math.ceil(MAX_SKIN_BYTES / 3) * 4
  )
    throw Error("皮肤必须是小于或等于 2 MB 的 PNG 图片。");
  const encoded = dataUrl.slice(PREFIX.length);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw Error("皮肤 PNG 数据无效。");
  const data = Buffer.from(encoded, "base64");
  if (data.length > MAX_SKIN_BYTES || data.toString("base64") !== encoded)
    throw Error("皮肤 PNG 数据无效或超过 2 MB。");
  validateLibraryPng(data);
  return data;
}

/** Only generated IDs form filenames; names and renderer URLs are never paths. */
export class SkinLibrary {
  private readonly directory: string;
  private readonly index: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    if (!path.isAbsolute(dataDir)) throw Error("皮肤库需要绝对数据目录。");
    this.directory = path.join(dataDir, "skins");
    this.index = path.join(this.directory, "index.json");
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async plain(file: string, directory = false): Promise<void> {
    const stat = await fs.lstat(file);
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile())
    )
      throw Error("皮肤库不支持链接、联接或特殊文件。");
  }

  private async prepare(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.plain(this.dataDir, true);
    await fs.mkdir(this.directory).catch((error: any) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.plain(this.directory, true);
    if (
      path.relative(
        await fs.realpath(this.dataDir),
        await fs.realpath(this.directory),
      ) !== "skins"
    )
      throw Error("皮肤库目录超出数据目录。");
  }

  private async records(): Promise<RecordEntry[]> {
    await this.prepare();
    try {
      await this.plain(this.index);
      const stat = await fs.stat(this.index);
      if (stat.size > MAX_INDEX_BYTES) throw Error("皮肤库索引过大。");
      const index = JSON.parse(await fs.readFile(this.index, "utf8"));
      if (
        index.version !== 1 ||
        !Array.isArray(index.entries) ||
        index.entries.length > MAX_ENTRIES
      )
        throw Error("皮肤库索引格式无效。");
      const ids = new Set<string>();
      return index.entries.map((entry: any) => {
        const id = idOf(entry?.id);
        if (ids.has(id)) throw Error("皮肤库索引包含重复标识。");
        ids.add(id);
        if (
          typeof entry.createdAt !== "string" ||
          !Number.isFinite(Date.parse(entry.createdAt)) ||
          typeof entry.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(entry.updatedAt))
        )
          throw Error("皮肤库时间记录无效。");
        return {
          id,
          name: nameOf(entry.name),
          variant: variantOf(entry.variant),
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        };
      });
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async commit(entries: RecordEntry[]): Promise<void> {
    const temporary = path.join(this.directory, `.index-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(
        temporary,
        JSON.stringify({ version: 1, entries }, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      // Recheck the publication target, including links created since records().
      await this.plain(this.index).catch((error: any) => {
        if (error.code !== "ENOENT") throw error;
      });
      await fs.rename(temporary, this.index);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  private async image(
    entry: RecordEntry,
  ): Promise<{ file: string; data: Buffer }> {
    const file = path.join(this.directory, `${idOf(entry.id)}.png`);
    await this.plain(file);
    const stat = await fs.stat(file);
    if (stat.size > MAX_SKIN_BYTES)
      throw Error(`皮肤「${entry.name}」超过 2 MB。`);
    const data = await fs.readFile(file);
    if (data.length > MAX_SKIN_BYTES) throw Error("皮肤文件超过 2 MB。");
    validateLibraryPng(data);
    return { file, data };
  }

  private async hydrate(entry: RecordEntry): Promise<SkinLibraryEntry> {
    const { data } = await this.image(entry);
    return { ...entry, dataUrl: PREFIX + data.toString("base64") };
  }

  list(): Promise<SkinLibraryEntry[]> {
    return this.serialized(async () => {
      const entries = await this.records();
      const result: SkinLibraryEntry[] = [];
      for (const entry of entries) result.push(await this.hydrate(entry));
      return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }

  save(input: {
    name: string;
    variant: "classic" | "slim";
    dataUrl: string;
  }): Promise<SkinLibraryEntry> {
    return this.serialized(async () => {
      const name = nameOf(input?.name),
        variant = variantOf(input?.variant);
      const data = decodeLibrarySkin(input?.dataUrl);
      const entries = await this.records();
      if (entries.length >= MAX_ENTRIES)
        throw Error(`皮肤库最多保存 ${MAX_ENTRIES} 件皮肤，请先删除部分收藏。`);
      const now = new Date().toISOString();
      const entry: RecordEntry = {
        id: randomUUID(),
        name,
        variant,
        createdAt: now,
        updatedAt: now,
      };
      const file = path.join(this.directory, `${entry.id}.png`);
      await fs.writeFile(file, data, { flag: "wx", mode: 0o600 });
      try {
        await this.commit([...entries, entry]);
      } catch (error) {
        await fs.unlink(file).catch(() => {});
        throw error;
      }
      return { ...entry, dataUrl: PREFIX + data.toString("base64") };
    });
  }

  rename(id: string, name: string): Promise<SkinLibraryEntry> {
    return this.serialized(async () => {
      idOf(id);
      const validatedName = nameOf(name);
      const entries = await this.records();
      const current = entries.find((entry) => entry.id === id);
      if (!current) throw Error("皮肤已不存在，请刷新皮肤库。");
      const result = await this.hydrate({
        ...current,
        name: validatedName,
        updatedAt: new Date().toISOString(),
      });
      await this.commit(
        entries.map((entry) =>
          entry.id === id
            ? { ...current, name: result.name, updatedAt: result.updatedAt }
            : entry,
        ),
      );
      return result;
    });
  }

  remove(id: string): Promise<void> {
    return this.serialized(async () => {
      idOf(id);
      const entries = await this.records();
      const entry = entries.find((entry) => entry.id === id);
      if (!entry) throw Error("皮肤已不存在，请刷新皮肤库。");
      const { file } = await this.image(entry);
      await this.commit(entries.filter((item) => item.id !== id));
      await fs.unlink(file);
    });
  }

  file(id: string): Promise<string> {
    return this.serialized(async () => {
      idOf(id);
      const entries = await this.records();
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw Error("皮肤已不存在，请刷新皮肤库。");
      return (await this.image(entry)).file;
    });
  }
}
