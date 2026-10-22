import path from "node:path";

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
