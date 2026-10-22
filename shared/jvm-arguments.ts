/** Advanced arguments never gain classpath, agent, filesystem or authentication control. */
export function validateExtraJvmArguments(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 16)
    throw Error("JVM 建议必须为最多 16 项的参数数组");
  const allowed =
    /^(?:-XX:[+-](?:UseG1GC|UseParallelGC|UseSerialGC|ParallelRefProcEnabled|UseStringDeduplication|DisableExplicitGC)|-XX:(?:MaxGCPauseMillis|G1NewSizePercent|G1MaxNewSizePercent|G1ReservePercent|InitiatingHeapOccupancyPercent)=\d{1,5})$/;
  const result: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || !allowed.test(value))
      throw Error("JVM 参数不在允许的性能建议范围内");
    const match = /^-XX:([^=]+)=(\d+)$/.exec(value);
    if (
      match &&
      (Number(match[2]) < 1 ||
        Number(match[2]) > (match[1] === "MaxGCPauseMillis" ? 10000 : 100))
    )
      throw Error("JVM 参数数值超出范围");
    if (!result.includes(value)) result.push(value);
  }
  if (
    result.filter((value) => /^-XX:\+Use(?:G1|Parallel|Serial)GC$/.test(value))
      .length > 1
  )
    throw Error("不能同时指定多个垃圾收集器");
  return result;
}
