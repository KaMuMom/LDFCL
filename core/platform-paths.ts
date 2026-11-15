import path from "node:path";

/** Resolve platform facilities from the host environment, never a fixed drive. */
export function windowsPowerShellPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const systemRoot = env.SystemRoot || env.windir;
  return systemRoot && path.isAbsolute(systemRoot)
    ? path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
}

export function javaSearchRoots(
  dataDir: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const vendors = [
    "Java",
    "Eclipse Adoptium",
    "Microsoft",
    "Amazon Corretto",
    "Zulu",
    "BellSoft",
  ];
  const programRoots = [
    ...new Set(
      [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
        (value): value is string => !!value && path.isAbsolute(value),
      ),
    ),
  ];
  return [
    path.join(dataDir, "runtime"),
    ...programRoots.flatMap((root) =>
      vendors.map((vendor) => path.join(root, vendor)),
    ),
    path.join(home, ".jdks"),
    path.join(home, ".jabba", "jdk"),
    path.join(home, "scoop", "apps", "temurin-jdk"),
    ...(env.APPDATA && path.isAbsolute(env.APPDATA)
      ? [path.join(env.APPDATA, ".minecraft", "runtime")]
      : []),
  ];
}
