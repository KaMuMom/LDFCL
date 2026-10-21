import path from "node:path";

class TransferQueue {
  private active = 0;
  private limit = 8;
  private pending: Array<() => void> = [];
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
      this.active++;
      this.pending.shift()!();
    }
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.pending.push(resolve);
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
