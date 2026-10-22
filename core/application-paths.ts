import path from "node:path";

export interface ProgramDirectoryOptions {
  isPackaged: boolean;
  execPath: string;
  appPath: string;
  portableExecutableDir?: string;
  dataDirOverride?: string;
}

function absoluteDirectory(value: string): string {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value))
    throw new Error("程序与配置目录必须使用完整的绝对路径。");
  return path.resolve(value);
}

/** Portable builds extract Electron to TEMP; persist beside the outer EXE. */
export function resolveProgramDirectory(
  options: ProgramDirectoryOptions,
): string {
  if (!options.isPackaged) return absoluteDirectory(options.appPath);
  return options.portableExecutableDir
    ? absoluteDirectory(options.portableExecutableDir)
    : path.dirname(absoluteDirectory(options.execPath));
}

export function resolveLauncherDataDirectory(
  options: ProgramDirectoryOptions,
): string {
  if (options.dataDirOverride)
    return absoluteDirectory(options.dataDirOverride);
  return path.join(resolveProgramDirectory(options), "LDFCL-data");
}
