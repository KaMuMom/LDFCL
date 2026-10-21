export function taskProgressPercent(task: {
  status: string;
  progress: number;
}): number {
  if (task.status === "completed") return 100;
  return Math.max(
    0,
    Math.min(
      99,
      Math.floor(Number.isFinite(task.progress) ? task.progress : 0),
    ),
  );
}
