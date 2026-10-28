import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import {
  JAVA_BOOTSTRAP_CLASS_BASE64,
  JAVA_BOOTSTRAP_CLASS_SHA256,
} from "./java-bootstrap-bytecode";

const BOOTSTRAP_MAIN = "io.ldfcl.launch.LaunchBootstrap";
const COMMAND_LIMIT = 24000;
const NON_ASCII = /[^\x20-\x7e]/;

export interface JavaLaunchInput {
  executable: string;
  jvmArguments: readonly string[];
  mainClass: string;
  gameArguments: readonly string[];
  classpath: readonly string[];
  cwd: string;
  /** Physical roots stay unchanged. Junctions only exist in a per-run staging
   * directory and are used after the launcher's instance/path checks finish. */
  roots?: readonly string[];
  platform?: NodeJS.Platform;
  temporaryRoot?: string;
}

export interface JavaLaunchInvocation {
  executable: string;
  args: string[];
  cwd: string;
  /** Sent through the child's anonymous stdin pipe, never saved to disk. */
  stdin?: Buffer;
  directory?: string;
  dispose(): Promise<void>;
}

function commandLength(executable: string, arguments_: readonly string[]): number {
  // Account for Windows quoting/backslash expansion; leave room below 32767.
  return executable.length + arguments_.reduce((sum, value) => sum + value.length * 2 + 3, 0);
}

/** JAR manifest lines contain ASCII file URLs and must wrap at 72 bytes. */
export function manifestClasspath(classpath: readonly string[]): string {
  const urls = classpath.map((value) => pathToFileURL(value).href).join(" ");
  const source = `Class-Path: ${urls}`;
  const lines: string[] = [];
  for (let offset = 0; offset < source.length;) {
    const size = offset === 0 ? 70 : 69;
    lines.push(`${offset === 0 ? "" : " "}${source.slice(offset, offset + size)}`);
    offset += size;
  }
  return `Manifest-Version: 1.0\r\n${lines.join("\r\n")}\r\n\r\n`;
}

function payload(
  classpath: string,
  mainClass: string,
  properties: readonly [string, string][],
  arguments_: readonly string[],
): Buffer {
  const parts: Buffer[] = [];
  let bytes = 0;
  const integer = (value: number) => {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32BE(value);
    parts.push(buffer);
    bytes += 4;
  };
  const string = (value: string) => {
    if (value.includes("\0")) throw Error("启动参数包含无效字符");
    const buffer = Buffer.from(value, "utf8");
    if (buffer.length > 16 * 1024 * 1024) throw Error("启动参数过长");
    integer(buffer.length);
    parts.push(buffer);
    bytes += buffer.length;
  };
  if (properties.length > 100000 || arguments_.length > 100000)
    throw Error("启动参数过多");
  integer(0x4c444631);
  string(classpath);
  string(mainClass);
  integer(properties.length);
  for (const [key, value] of properties) {
    string(key);
    string(value);
  }
  integer(arguments_.length);
  for (const value of arguments_) string(value);
  if (bytes > 32 * 1024 * 1024) throw Error("启动参数总长度过大");
  return Buffer.concat(parts, bytes);
}

async function privateStage(temporaryRoot?: string): Promise<string> {
  const preferred = temporaryRoot || os.tmpdir();
  if (!NON_ASCII.test(preferred))
    return fs.mkdtemp(path.join(preferred, "ldfcl-launch-"));
  // A Windows username may itself contain emoji. ProgramData supplies an ASCII
  // staging location without changing TEMP, filesystem ACLs or game files.
  // Only public helper bytecode/path manifests are saved; tokens use the pipe.
  const base = process.env.ProgramData || `${path.parse(process.execPath).root}ProgramData`;
  if (NON_ASCII.test(base)) throw Error("无法为 Java 创建兼容的临时启动目录");
  return fs.mkdtemp(path.join(base, "LDFCL-launch-")).catch(() => {
    throw Error("无法创建 Java 临时启动目录，请检查 Windows 目录权限");
  });
}

/** Windows' java.exe can narrow argv to the ANSI code page even when Node uses
 * CreateProcessW. A UTF-8 argfile does not fix Java 8 and is also decoded using
 * the native charset by several newer JVMs. Instead, a small Java 8 bootstrap
 * receives UTF-8 game arguments over stdin, with a manifest on the regular
 * system class loader. ASCII junction paths also preserve native DLL lookup.
 */
export async function prepareJavaLaunch(input: JavaLaunchInput): Promise<JavaLaunchInvocation> {
  const platform = input.platform || process.platform;
  const direct = [...input.jvmArguments, input.mainClass, ...input.gameArguments];
  const windows = platform === "win32";
  const unicode = windows && [input.cwd, input.executable, ...direct].some((value) => NON_ASCII.test(value));
  if (!unicode && commandLength(input.executable, direct) <= COMMAND_LIMIT)
    return { executable: input.executable, args: direct, cwd: input.cwd, dispose: async () => {} };

  const stage = windows ? await privateStage(input.temporaryRoot) : await fs.mkdtemp(path.join(input.temporaryRoot || os.tmpdir(), "ldfcl-launch-"));
  const junctions: string[] = [];
  const files: string[] = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    // Remove only recorded links/files. Never recursively traverse a junction:
    // its target contains the user's worlds, mods and screenshots.
    for (const link of junctions.reverse()) {
      const stat = await fs.lstat(link).catch(() => null);
      if (stat?.isSymbolicLink()) await fs.unlink(link).catch(() => fs.rmdir(link));
    }
    for (const file of files) await fs.unlink(file).catch(() => {});
    await fs.rmdir(stage).catch(() => {});
  };
  try {
    const aliases: { source: string; target: string }[] = [];
    if (windows) {
      const roots = [input.cwd, ...(input.roots || [])];
      if (path.isAbsolute(input.executable) && /^javaw?\.exe$/i.test(path.basename(input.executable)))
        roots.push(path.dirname(path.dirname(input.executable)));
      for (const argument of input.jvmArguments) {
        const match = /^-D(?:java\.library\.path|org\.lwjgl\.librarypath|net\.java\.games\.input\.librarypath)=(.*)$/.exec(argument);
        if (match) roots.push(...match[1].split(path.delimiter));
      }
      for (const root of roots) {
        if (!path.isAbsolute(root) || aliases.some((entry) => entry.source.toLowerCase() === path.resolve(root).toLowerCase())) continue;
        const source = path.resolve(root);
        if (!(await fs.stat(source).catch(() => null))?.isDirectory()) continue;
        const target = path.join(stage, `path-${aliases.length}`);
        await fs.symlink(source, target, "junction");
        junctions.push(target);
        aliases.push({ source, target });
      }
      aliases.sort((a, b) => b.source.length - a.source.length);
    }
    const map = (value: string): string => {
      if (!aliases.length) return value;
      const alternatives = aliases.map((alias) => alias.source.split(/[\\/]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]")).join("|");
      // One replacement pass prevents a drive-root alias from rewriting the
      // newly inserted staging path and recursively aliasing itself.
      return value.replace(new RegExp(`(?:${alternatives})(?=$|[\\\\/;])`, "gi"), (source) => aliases.find((alias) => alias.source.toLowerCase() === path.resolve(source).toLowerCase())!.target);
    };
    const classpath = input.classpath.map(map);
    const bytes = Buffer.from(JAVA_BOOTSTRAP_CLASS_BASE64, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== JAVA_BOOTSTRAP_CLASS_SHA256)
      throw Error("Java 启动组件校验失败");
    const jar = new AdmZip();
    const manifestPaths = await Promise.all(classpath.map(async (entry) => (await fs.stat(entry).catch(() => null))?.isDirectory() ? entry + path.sep : entry));
    jar.addFile("META-INF/MANIFEST.MF", Buffer.from(manifestClasspath(manifestPaths), "ascii"));
    jar.addFile("io/ldfcl/launch/LaunchBootstrap.class", bytes);
    const bootstrap = path.join(stage, "bootstrap.jar");
    await fs.writeFile(bootstrap, jar.toBuffer(), { flag: "wx", mode: 0o600 });
    files.push(bootstrap);
    const properties: [string, string][] = [];
    const args: string[] = [];
    for (let index = 0; index < input.jvmArguments.length; index++) {
      const argument = input.jvmArguments[index];
      if (["-cp", "-classpath", "--class-path"].includes(argument)) { index++; continue; }
      if (argument.startsWith("--class-path=")) continue;
      const mapped = map(argument);
      const property = /^-D([^=]+)=(.*)$/s.exec(mapped);
      if (property && (NON_ASCII.test(mapped) || mapped.length > 4096)) {
        if (/^(?:java\.library\.path|org\.lwjgl\.librarypath|net\.java\.games\.input\.librarypath|file\.encoding|sun\.jnu\.encoding|java\.home|user\.dir)$/.test(property[1]))
          throw Error("Java 初始化路径无法转换为兼容路径，请检查自定义运行库位置");
        properties.push([property[1], property[2]]);
      } else {
        if (windows && NON_ASCII.test(mapped))
          throw Error("此版本包含无法兼容的 Java 初始化参数，请检查加载器配置");
        args.push(mapped);
      }
    }
    args.push("-cp", bootstrap, BOOTSTRAP_MAIN);
    const executable = map(input.executable);
    if (commandLength(executable, args) > COMMAND_LIMIT)
      throw Error("此版本的 Java 初始化参数过长，请检查加载器配置");
    return {
      executable,
      args,
      cwd: map(input.cwd),
      stdin: payload(classpath.join(path.delimiter), input.mainClass, properties, input.gameArguments.map(map)),
      directory: stage,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
