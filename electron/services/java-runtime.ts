import path from "node:path";

// Independent implementation. Design review: KAMUCL's Java discovery separates
// runtime identity from executable aliases (30874ab, https://github.com/YUN-SAN3/KAMUCL).
export type JavaArchitecture = "x64" | "ia32" | "arm64" | "unknown";
export interface JavaInstallation {
  path: string;
  major: number;
  version: string;
  architecture?: JavaArchitecture;
  home?: string;
}

function property(output: string, name: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line))
    .find((match) => match?.[1] === name)?.[2];
}

export function javaMajor(output: string): number | null {
  const version =
    property(output, "java.version") ||
    property(output, "java.specification.version");
  const match =
    version?.match(/^(\d+)(?:\.(\d+))?/) ||
    output.match(/(?:openjdk|java)\s+(?:version\s+)?["']?(\d+)(?:\.(\d+))?/i) ||
    output.match(/version\s+["'](\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  const major = Number(match[1]) === 1 ? Number(match[2]) : Number(match[1]);
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

export function normalizeJavaArchitecture(value: string): JavaArchitecture {
  const normalized = value.toLowerCase().replace(/[\s_-]/g, "");
  if (["amd64", "x8664", "x64"].includes(normalized)) return "x64";
  if (/^(?:x86|ia32|i[3-6]86)$/.test(normalized)) return "ia32";
  if (["arm64", "aarch64"].includes(normalized)) return "arm64";
  return "unknown";
}

export function parseJavaInstallation(
  output: string,
  executable: string,
): JavaInstallation | null {
  const major = javaMajor(output);
  if (!major) return null;
  const rawArchitecture = property(output, "os.arch");
  return {
    path: executable,
    major,
    version:
      property(output, "java.version") ||
      output
        .split(/\r?\n/)
        .find((line) =>
          /(?:java|openjdk).*version|^openjdk\s+\d/i.test(line),
        ) ||
      `Java ${major}`,
    architecture: rawArchitecture
      ? normalizeJavaArchitecture(rawArchitecture)
      : /64-Bit/i.test(output)
        ? "x64"
        : "unknown",
    home: property(output, "java.home"),
  };
}

export function compatibleJavaArchitecture(
  info: JavaInstallation,
  architecture = process.arch,
): boolean {
  // Old integrations may provide no architecture. A probe with an explicit
  // unsupported architecture must never masquerade as a compatible JVM.
  return info.architecture === undefined || info.architecture === architecture;
}

/** Accept an executable, JDK/JRE home, or bin directory, preserving spaces. */
export function javaExecutables(
  value: string,
  platform = process.platform,
): string[] {
  const selected = value.trim().replace(/^"(.*)"$/, "$1");
  if (!selected) return [];
  const paths = platform === "win32" ? path.win32 : path.posix;
  const name = platform === "win32" ? "java.exe" : "java";
  const basename = paths.basename(selected);
  const bareCommand =
    basename === selected && /^(?:java|javaw)(?:\.exe)?$/i.test(basename);
  if (
    bareCommand ||
    /^(?:java|javaw)\.exe$/i.test(basename) ||
    (platform !== "win32" && /^(?:java|javaw)$/i.test(basename))
  )
    return [selected.replace(/javaw(?=\.exe$|$)/i, "java")];
  if (paths.basename(selected).toLowerCase() === "bin")
    return [paths.join(selected, name)];
  return [paths.join(selected, "bin", name)];
}

export function realJavaExecutable(
  info: JavaInstallation,
  platform = process.platform,
): string | undefined {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!info.home || !paths.isAbsolute(info.home)) return undefined;
  return paths.join(
    info.home,
    "bin",
    platform === "win32" ? "java.exe" : "java",
  );
}
