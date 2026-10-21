import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LAUNCHER_USER_AGENT } from "../../shared/launcher";
import {
  destinationKey,
  transferQueue,
  withDestination,
} from "./download-queue";

export interface DownloadItem {
  url: string;
  path: string;
  sha1?: string;
  sha256?: string;
  sha512?: string;
  size?: number;
  maxBytes?: number;
  requireHttps?: boolean;
}
export type Emit = (event: any) => void;
type Meter = (received: number, total: number) => void;
const algorithms = ["sha1", "sha256", "sha512"] as const;
class TransferError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
function httpError(status: number, url: string): TransferError {
  return new TransferError(
    `请求失败 (${status}): ${new URL(url).hostname}`,
    [408, 425, 429].includes(status) || status >= 500,
  );
}
function canRetry(error: unknown): boolean {
  if (error instanceof TransferError) return error.retryable;
  return ![
    "EACCES",
    "EPERM",
    "ENOSPC",
    "EROFS",
    "EISDIR",
    "ENOTDIR",
    "EINVAL",
  ].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
const backoff = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
export async function fileHash(
  file: string,
  algorithm = "sha1",
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function validate(item: DownloadItem): void {
  const url = new URL(item.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (item.requireHttps && url.protocol !== "https:")
  )
    throw new TransferError("下载地址必须使用有效的 HTTP/HTTPS 协议");
  for (const [value, name] of [
    [item.size, "文件大小"],
    [item.maxBytes, "下载上限"],
  ] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new TransferError(`${name}无效`);
  if (
    item.size !== undefined &&
    item.maxBytes !== undefined &&
    item.size > item.maxBytes
  )
    throw new TransferError("文件大小超过下载上限");
  for (const algorithm of algorithms) {
    const digest = item[algorithm];
    const length = { sha1: 40, sha256: 64, sha512: 128 }[algorithm];
    if (
      digest !== undefined &&
      !new RegExp(`^[a-f0-9]{${length}}$`, "i").test(digest)
    )
      throw new TransferError(`${algorithm} 校验值无效`);
  }
}
function mergeDestinations(items: DownloadItem[]): DownloadItem[] {
  const destinations = new Map<string, DownloadItem>();
  for (const item of items) {
    validate(item);
    const key = destinationKey(item.path);
    const previous = destinations.get(key);
    if (!previous) {
      destinations.set(key, { ...item });
      continue;
    }
    for (const field of [...algorithms, "size"] as const) {
      const a = previous[field],
        b = item[field];
      if (
        a !== undefined &&
        b !== undefined &&
        String(a).toLowerCase() !== String(b).toLowerCase()
      )
        throw new TransferError(
          `同一下载目标存在冲突的 ${field}：${path.basename(item.path)}`,
        );
    }
    const merged = { ...previous, ...item };
    for (const algorithm of algorithms)
      merged[algorithm] = item[algorithm] ?? previous[algorithm];
    merged.size = item.size ?? previous.size;
    merged.maxBytes = Math.min(
      item.maxBytes ?? Infinity,
      previous.maxBytes ?? Infinity,
    );
    if (!Number.isFinite(merged.maxBytes)) delete merged.maxBytes;
    merged.requireHttps = previous.requireHttps || item.requireHttps;
    validate(merged);
    destinations.set(key, merged);
  }
  return [...destinations.values()];
}
async function valid(item: DownloadItem): Promise<boolean> {
  try {
    const stat = await fs.lstat(item.path);
    if (
      !stat.isFile() ||
      (item.size !== undefined && item.size !== stat.size) ||
      (item.maxBytes !== undefined && stat.size > item.maxBytes)
    )
      return false;
    const expected = algorithms.filter(
      (algorithm) => item[algorithm] !== undefined,
    );
    if (!expected.length) return stat.size > 0 || item.size === 0;
    const hashes = expected.map((algorithm) => createHash(algorithm));
    for await (const chunk of createReadStream(item.path))
      for (const hash of hashes) hash.update(chunk);
    return hashes.every(
      (hash, index) =>
        hash.digest("hex") === item[expected[index]]!.toLowerCase(),
    );
  } catch {
    return false;
  }
}
export async function requestJson<T = any>(url: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": LAUNCHER_USER_AGENT },
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw httpError(response.status, url);
      }
      return (await response.json()) as T;
    } catch (error) {
      last = error;
      if (!canRetry(error) || attempt === 2) break;
      await backoff(attempt);
    }
  }
  throw last;
}
export class DownloadManager {
  constructor(
    public dataDir: string,
    private emit: Emit = () => {},
    concurrency = 8,
  ) {
    this.concurrency = concurrency;
  }
  get concurrency(): number {
    return transferQueue.concurrency;
  }
  set concurrency(value: number) {
    transferQueue.concurrency = value;
  }

  async download(
    url: string,
    dest: string,
    sha1?: string,
    size?: number,
    label?: string,
  ): Promise<void> {
    return this.downloadVerified({ url, path: dest, sha1, size }, label);
  }
  async downloadVerified(item: DownloadItem, label?: string): Promise<void> {
    const id = randomUUID();
    let progress = 0;
    const report = (status: string, detail?: string) => {
      if (label)
        this.emit({
          type: "task",
          task: {
            id,
            title: label,
            progress: status === "completed" ? 1 : progress,
            status,
            detail,
          },
        });
    };
    report("running");
    try {
      await this.transfer(item, (received, total) => {
        progress = total ? Math.min(0.99, received / total) : 0;
        report(
          "running",
          `${(received / 1048576).toFixed(1)} / ${total ? (total / 1048576).toFixed(1) : "?"} MB`,
        );
      });
      report("completed");
    } catch (error) {
      report("failed", String(error));
      throw error;
    }
  }
  private async transfer(item: DownloadItem, meter: Meter): Promise<void> {
    validate(item);
    await withDestination(item.path, async () => {
      if (await valid(item)) {
        meter(item.size ?? (await fs.stat(item.path)).size, item.size ?? 0);
        return;
      }
      await fs.mkdir(path.dirname(item.path), { recursive: true });
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        meter(0, item.size ?? 0);
        try {
          await transferQueue.run(() => this.attempt(item, meter));
          return;
        } catch (error) {
          last = error;
          if (!canRetry(error) || attempt === 2) break;
          await backoff(attempt);
        }
      }
      throw last;
    });
  }
  private async attempt(item: DownloadItem, meter: Meter): Promise<void> {
    const temporary = `${item.path}.${randomUUID()}.part`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), 60000);
    };
    try {
      touch();
      response = await fetch(item.url, {
        headers: { "User-Agent": LAUNCHER_USER_AGENT },
        signal: controller.signal,
      });
      if (item.requireHttps && new URL(response.url).protocol !== "https:")
        throw new TransferError("下载重定向至非 HTTPS 地址");
      if (!response.ok) throw httpError(response.status, item.url);
      if (!response.body) throw new TransferError("下载响应为空", true);
      const rawLength = response.headers.get("content-length");
      const parsedLength =
        rawLength !== null && !response.headers.get("content-encoding")
          ? Number(rawLength)
          : undefined;
      const headerLength =
        parsedLength !== undefined &&
        Number.isSafeInteger(parsedLength) &&
        parsedLength >= 0
          ? parsedLength
          : undefined;
      if (headerLength !== undefined) {
        if (item.maxBytes !== undefined && headerLength > item.maxBytes)
          throw new TransferError("文件大小超过下载上限");
        if (item.size !== undefined && item.size !== headerLength)
          throw new TransferError("下载文件大小与预期不符", true);
      }
      const total = item.size ?? headerLength ?? 0;
      let received = 0,
        lastUpdate = 0;
      const meterStream = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length;
          touch();
          if (
            (item.maxBytes !== undefined && received > item.maxBytes) ||
            (item.size !== undefined && received > item.size)
          ) {
            callback(new TransferError("下载文件超出预期大小"));
            return;
          }
          if (Date.now() - lastUpdate >= 200) {
            meter(received, total);
            lastUpdate = Date.now();
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as any),
        meterStream,
        createWriteStream(temporary, { flags: "wx" }),
      );
      clearTimeout(timer);
      meter(received, total);
      if (!(await valid({ ...item, path: temporary })))
        throw new TransferError("下载文件校验失败，将自动重试", true);
      // Rename publishes a verified file; an existing destination stays intact if publication fails.
      await fs.rename(temporary, item.path);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await response?.body?.cancel().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  async downloadMany(
    items: DownloadItem[],
    label = "下载游戏文件",
  ): Promise<void> {
    const id = randomUUID();
    let unique: DownloadItem[];
    try {
      unique = mergeDestinations(items);
    } catch (error) {
      this.emit({
        type: "task",
        task: {
          id,
          title: label,
          progress: 0,
          status: "failed",
          detail: String(error),
        },
      });
      throw error;
    }
    const sizesKnown = unique.every(
      (item) => item.size !== undefined && item.size >= 0,
    );
    const totalBytes = sizesKnown
      ? unique.reduce((sum, item) => sum + item.size!, 0)
      : 0;
    const received = new Map<DownloadItem, number>();
    let next = 0,
      done = 0,
      failed = false,
      failure: unknown;
    const report = (status: string) => {
      const fraction = totalBytes
        ? [...received.values()].reduce((sum, value) => sum + value, 0) /
          totalBytes
        : done / Math.max(1, unique.length);
      this.emit({
        type: "task",
        task: {
          id,
          title: label,
          progress: status === "completed" ? 1 : Math.min(0.99, fraction),
          status,
          detail: failed ? String(failure) : `${done} / ${unique.length}`,
        },
      });
    };
    report("running");
    const worker = async () => {
      while (next < unique.length && !failed) {
        const item = unique[next++];
        try {
          await this.transfer(item, (bytes) => {
            received.set(item, Math.min(bytes, item.size ?? bytes));
            report("running");
          });
          received.set(item, item.size ?? 0);
          done++;
          report("running");
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.concurrency, Math.max(1, unique.length)) },
        worker,
      ),
    );
    report(failed ? "failed" : "completed");
    if (failed) throw failure;
  }
}
