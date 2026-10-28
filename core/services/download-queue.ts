import path from "node:path";
import type {
  DownloadFilePage,
  DownloadFileProgress,
} from "../../shared/types";

// Keep detailed lists out of progress events: a vanilla asset index can contain
// tens of thousands of files. The renderer fetches a bounded page on demand.
const fileLists = new Map<
  string,
  { files: DownloadFileProgress[]; active: boolean }
>();
export function registerDownloadFiles(
  id: string,
  files: DownloadFileProgress[],
): void {
  fileLists.set(id, { files, active: true });
  trimFileLists();
}
export function finishDownloadFiles(id: string): void {
  const list = fileLists.get(id);
  if (list) list.active = false;
  trimFileLists();
}
function trimFileLists(): void {
  let count = [...fileLists.values()].reduce(
    (sum, list) => sum + list.files.length,
    0,
  );
  let completed = [...fileLists.values()].filter((list) => !list.active).length;
  for (const [id, list] of fileLists) {
    if (list.active || (count <= 150000 && completed <= 30)) continue;
    fileLists.delete(id);
    count -= list.files.length;
    completed--;
  }
}
export function getDownloadTaskFiles(
  id: string,
  offset = 0,
  limit = 50,
): DownloadFilePage {
  if (typeof id !== "string" || id.length > 128)
    throw new Error("下载任务标识无效");
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("下载文件分页参数无效");
  const list = fileLists.get(id);
  if (!list) throw new Error("此任务的文件清单已过期，可查看后续下载任务");
  return {
    taskId: id,
    offset,
    total: list.files.length,
    files: list.files
      .slice(offset, offset + limit)
      .map((file) => ({ ...file })),
  };
}

class TransferQueue {
  private active = 0;
  private limit = 8;
  private pending: Array<{
    start: () => void;
    signal?: AbortSignal;
    abort: () => void;
  }> = [];
  get concurrency(): number {
    return this.limit;
  }
  set concurrency(value: number) {
    this.limit = Math.max(
      1,
      Math.min(32, Math.floor(Number.isFinite(value) ? value : 8)),
    );
    this.drain();
  }
  private drain(): void {
    while (this.active < this.limit && this.pending.length) {
      const entry = this.pending.shift()!;
      entry.signal?.removeEventListener("abort", entry.abort);
      this.active++;
      entry.start();
    }
  }
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const entry = {
        start: resolve,
        signal,
        abort: () => {
          const index = this.pending.indexOf(entry);
          if (index !== -1) this.pending.splice(index, 1);
          reject(signal?.reason || new Error("下载已中断"));
        },
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.pending.push(entry);
      this.drain();
    });
    try {
      return await operation();
    } finally {
      this.active--;
      this.drain();
    }
  }
}

export const transferQueue = new TransferQueue();
export function destinationKey(destination: string): string {
  const resolved = path.resolve(destination);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
const destinations = new Map<string, Promise<void>>();
export async function withDestination<T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = destinationKey(destination);
  const previous = destinations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  destinations.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (destinations.get(key) === current) destinations.delete(key);
  }
}
