import type { Task } from "./types";

export interface UiEventBatch {
  tasks: Record<string, Task>;
  logs: Record<string, string[]>;
}

// Progress can arrive once per downloaded chunk, and Minecraft can emit many
// log lines in one frame. Keep the latest task snapshot and the last 500 log
// lines per instance, then update React together at most ten times a second.
export function createUiEventBuffer(
  publish: (batch: UiEventBatch) => void,
  schedule: (callback: () => void) => () => void = (callback) => {
    const timer = setTimeout(callback, 100);
    return () => clearTimeout(timer);
  },
) {
  let tasks: UiEventBatch["tasks"] = Object.create(null);
  let logs: UiEventBatch["logs"] = Object.create(null);
  let cancel: (() => void) | undefined;
  let disposed = false;
  const flush = () => {
    cancel?.();
    cancel = undefined;
    if (disposed || (!Object.keys(tasks).length && !Object.keys(logs).length))
      return;
    const batch = { tasks, logs };
    tasks = Object.create(null);
    logs = Object.create(null);
    publish(batch);
  };
  const queue = () => {
    if (!cancel && !disposed) cancel = schedule(flush);
  };
  return {
    task(task: Task) {
      if (disposed) return;
      tasks[task.id] = task;
      queue();
    },
    log(instanceId: string, line: string) {
      if (disposed) return;
      const lines = logs[instanceId] || (logs[instanceId] = []);
      lines.push(...line.split(/\r?\n/));
      if (lines.length > 500) lines.splice(0, lines.length - 500);
      queue();
    },
    flush,
    dispose() {
      disposed = true;
      cancel?.();
      cancel = undefined;
      tasks = Object.create(null);
      logs = Object.create(null);
    },
  };
}
