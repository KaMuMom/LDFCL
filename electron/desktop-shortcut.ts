import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DESKTOP_SHORTCUT_NAME = "LDFCL.lnk";
export const DESKTOP_SHORTCUT_APP_ID = "io.ldfcl.launcher";
const DESCRIPTION = "LDFCL Minecraft 启动器";
const LEGACY_EXECUTABLE =
  /^LDFCL(?:-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-Windows-x64)?\.exe$/i;
const LEGACY_SHORTCUT =
  /^LDFCL(?:[ _-]+v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:[ _-]+Windows[ _-]+x64)?)?(?:\.exe)?(?:\s*-\s*(?:快捷方式|Shortcut))?(?:\s*\(\d+\))?\.lnk$/i;

export interface DesktopShortcutDetails {
  target: string;
  cwd?: string;
  args?: string;
  description?: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId?: string;
}

export interface DesktopShortcutHost {
  readShortcutLink(shortcutPath: string): DesktopShortcutDetails;
  writeShortcutLink(
    shortcutPath: string,
    operation: "create" | "update" | "replace",
    options: DesktopShortcutDetails,
  ): boolean;
}

export interface DesktopShortcutOptions {
  platform?: string;
  /** Supply app.getPath("desktop"); do not construct USERPROFILE/Desktop. */
  desktopDirectory: string;
  /** The outer portable executable, never Electron's extracted process.execPath. */
  executablePath: string;
  shell: DesktopShortcutHost;
}

export interface DesktopShortcutResult {
  status:
    | "created"
    | "updated"
    | "unchanged"
    | "conflict"
    | "unsupported"
    | "invalid-executable"
    | "failed";
  shortcutPath: string;
  removed: string[];
  warnings: string[];
  message: string;
}

function normalized(value: string | undefined): string {
  return path.win32
    .normalize((value || "").replace(/^\\\\\?\\/, ""))
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function samePath(a: string | undefined, b: string): boolean {
  return !!a && normalized(a) === normalized(b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOwned(
  details: DesktopShortcutDetails,
  executable: string,
  directory: string,
  strictLegacy: boolean,
): boolean {
  if (details.args?.trim()) return false;
  if (
    details.appUserModelId &&
    details.appUserModelId !== DESKTOP_SHORTCUT_APP_ID
  )
    return false;
  // An exact target identifies this installation even if older links had no
  // icon/working directory. The fixed shortcut can safely repair those fields.
  const exactTarget = samePath(details.target, executable);
  if (exactTarget && !strictLegacy) return true;
  // For deleting duplicates or migrating an older target, require all path
  // evidence together. A name or description alone never establishes ownership.
  return (
    samePath(path.dirname(details.target), directory) &&
    (exactTarget || LEGACY_EXECUTABLE.test(path.basename(details.target))) &&
    // Windows Send to Desktop may leave cwd blank. Only an exact current-EXE
    // target is sufficient to accept that default; old-version targets are not.
    (samePath(details.cwd, directory) || (exactTarget && !details.cwd)) &&
    // An empty icon is the shell's implicit executable icon (IconLocation=,0).
    // Any explicit icon belonging to another target remains user-owned.
    (!details.icon || samePath(details.icon, details.target)) &&
    (details.iconIndex ?? 0) === 0
  );
}

function isCurrent(
  details: DesktopShortcutDetails,
  expected: DesktopShortcutDetails,
): boolean {
  return (
    samePath(details.target, expected.target) &&
    samePath(details.cwd, expected.cwd!) &&
    samePath(details.icon, expected.icon!) &&
    (details.iconIndex ?? 0) === 0 &&
    !details.args?.trim() &&
    details.description === expected.description &&
    details.appUserModelId === expected.appUserModelId
  );
}

/** Maintain one desktop link for a portable installation, without executing OS scripts. */
export async function ensureDesktopShortcut(
  options: DesktopShortcutOptions,
): Promise<DesktopShortcutResult> {
  const { desktopDirectory, executablePath, shell } = options;
  const shortcutPath = path.join(desktopDirectory, DESKTOP_SHORTCUT_NAME);
  const result: DesktopShortcutResult = {
    status: "failed",
    shortcutPath,
    removed: [],
    warnings: [],
    message: "桌面快捷方式尚未更新。",
  };
  if ((options.platform ?? process.platform) !== "win32") {
    result.status = "unsupported";
    result.message = "桌面快捷方式仅适用于 Windows。";
    return result;
  }
  if (!path.isAbsolute(executablePath) || !/\.exe$/i.test(executablePath)) {
    result.status = "invalid-executable";
    result.message = "未提供有效的外部便携程序路径。";
    return result;
  }
  try {
    if (!(await fs.stat(executablePath)).isFile())
      throw Error("目标不是程序文件");
  } catch {
    result.status = "invalid-executable";
    result.message = "外部便携程序不存在，已保留现有桌面快捷方式。";
    return result;
  }
  const directory = path.dirname(executablePath);
  const expected: DesktopShortcutDetails = {
    target: executablePath,
    cwd: directory,
    args: "",
    description: DESCRIPTION,
    icon: executablePath,
    iconIndex: 0,
    appUserModelId: DESKTOP_SHORTCUT_APP_ID,
  };
  let stagingDirectory: string | undefined;
  try {
    if (!path.isAbsolute(desktopDirectory)) throw Error("桌面路径不是绝对路径");
    if (!(await fs.stat(desktopDirectory)).isDirectory())
      throw Error("桌面目录不存在");
    const entries = await fs.readdir(desktopDirectory, { withFileTypes: true });
    const existing = entries.find(
      (entry) =>
        entry.name.toLowerCase() === DESKTOP_SHORTCUT_NAME.toLowerCase(),
    );
    const fixedPath = existing
      ? path.join(desktopDirectory, existing.name)
      : shortcutPath;
    result.shortcutPath = fixedPath;
    if (existing) {
      let details: DesktopShortcutDetails | undefined;
      if (existing.isFile() && !existing.isSymbolicLink()) {
        try {
          details = shell.readShortcutLink(fixedPath);
        } catch {
          // An unreadable shortcut may belong to another application.
        }
      }
      if (!details || !isOwned(details, executablePath, directory, false)) {
        result.status = "conflict";
        result.message =
          "桌面 LDFCL.lnk 已被其他程序、其他安装或无法识别的项目占用，已保留原文件。";
        return result;
      }
      if (isCurrent(details, expected)) result.status = "unchanged";
      else {
        if (!shell.writeShortcutLink(fixedPath, "replace", expected))
          throw Error("Windows 未能更新快捷方式");
        result.status = "updated";
      }
    } else {
      // Build in TEMP and publish with COPYFILE_EXCL. Unlike shell's create
      // operation, this cannot overwrite an unrelated link created concurrently.
      stagingDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "LDFCL-link-"),
      );
      const stagingPath = path.join(stagingDirectory, DESKTOP_SHORTCUT_NAME);
      if (!shell.writeShortcutLink(stagingPath, "create", expected))
        throw Error("Windows 未能创建快捷方式");
      try {
        await fs.copyFile(stagingPath, fixedPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          result.status = "conflict";
          result.message = "桌面 LDFCL.lnk 已被占用，已保留原文件。";
          return result;
        }
        throw error;
      }
      result.status = "created";
    }
    if (!isCurrent(shell.readShortcutLink(fixedPath), expected))
      throw Error("快捷方式写入后的目标验证失败");

    // Only recognized historical names, targets inside this installation, no
    // launch arguments, matching/default cwd and matching/implicit icons qualify.
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.name.toLowerCase() === DESKTOP_SHORTCUT_NAME.toLowerCase() ||
        !LEGACY_SHORTCUT.test(entry.name)
      )
        continue;
      const candidate = path.join(desktopDirectory, entry.name);
      try {
        const details = shell.readShortcutLink(candidate);
        if (!isOwned(details, executablePath, directory, true)) continue;
        // Re-read immediately before removal, preserving any link retargeted
        // while enumeration or the fixed-link update was taking place.
        if (
          !isOwned(
            shell.readShortcutLink(candidate),
            executablePath,
            directory,
            true,
          )
        )
          continue;
        await fs.unlink(candidate);
        result.removed.push(candidate);
      } catch (error) {
        result.warnings.push(`${entry.name}：${errorMessage(error)}`);
      }
    }
    result.message =
      result.status === "unchanged"
        ? "桌面快捷方式已是最新。"
        : "桌面快捷方式已指向当前便携程序。";
  } catch (error) {
    result.status = "failed";
    result.message = `桌面快捷方式未能更新：${errorMessage(error)}`;
  } finally {
    if (stagingDirectory)
      await fs
        .rm(stagingDirectory, { recursive: true, force: true })
        .catch(() => {});
  }
  return result;
}
