// Independently implemented after reviewing KAMUCL's launch preparation boundary
// (30874ab, https://github.com/YUN-SAN3/KAMUCL); no upstream implementation copied.

/** The prepared files, memory setting and native directory are authoritative;
 * imported profiles can contain stale hard-coded paths or duplicate switches. */
export function prepareJvmArguments(
  input: readonly string[],
  classpath: string,
  natives: string,
): string[] {
  const result: string[] = [];
  let hasClasspath = false;
  let hasNatives = false;
  for (let index = 0; index < input.length; index++) {
    const argument = input[index];
    if (
      ["-cp", "-classpath", "--class-path"].includes(argument) ||
      argument.startsWith("--class-path=")
    ) {
      if (
        !argument.startsWith("--class-path=") &&
        input[index + 1] !== undefined &&
        !input[index + 1].startsWith("-")
      )
        index++;
      if (!hasClasspath) {
        result.push("-cp", classpath);
        hasClasspath = true;
      }
    } else if (argument.startsWith("-Djava.library.path=")) {
      if (!hasNatives) {
        result.push(`-Djava.library.path=${natives}`);
        hasNatives = true;
      }
    } else if (!/^-Xm[sx]/i.test(argument)) result.push(argument);
  }
  if (!hasClasspath) result.push("-cp", classpath);
  if (!hasNatives) result.push(`-Djava.library.path=${natives}`);
  return result;
}

export function nativeClassifier(
  library: any,
  platform = process.platform,
  architecture = process.arch,
): string | undefined {
  const operatingSystem =
    platform === "win32" ? "windows" : platform === "darwin" ? "osx" : "linux";
  const value = library.natives?.[operatingSystem];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || /[\\/:\x00-\x1f]/.test(value))
    throw new Error("无效原生库分类标识");
  return value.replace(/\$\{arch\}/g, architecture === "ia32" ? "32" : "64");
}

export function nativeExtractionAllowed(
  name: string,
  excludes: readonly string[] = [],
): boolean {
  const normalized = name.replace(/\\/g, "/");
  return (
    !normalized.startsWith("META-INF/") &&
    !normalized.endsWith(".git") &&
    !excludes.some((prefix) =>
      normalized.startsWith(prefix.replace(/\\/g, "/")),
    )
  );
}
