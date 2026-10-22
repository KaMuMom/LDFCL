import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { DownloadManager, Emit, requestJson } from "./downloads";
import {
  compatibleJavaArchitecture,
  javaExecutables,
  parseJavaInstallation,
  realJavaExecutable,
  type JavaInstallation,
} from "./java-runtime";
export { javaMajor } from "./java-runtime";

export function runProcess(
  executable: string,
  args: string[],
  cwd?: string,
  onLine?: (line: string) => void,
  timeout = 15 * 60 * 1000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("进程运行超时"));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-200000);
      onLine?.(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-200000);
      onLine?.(String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve({ stdout, stderr })
        : reject(
            new Error(`进程退出 (${code}): ${(stderr || stdout).slice(-1600)}`),
          );
    });
  });
}

export function automaticMemoryMb(
  total = os.totalmem(),
  free = os.freemem(),
): number {
  const totalMb = total / 1048576,
    freeMb = free / 1048576;
  return Math.max(
    512,
    Math.min(
      8192,
      Math.floor(
        Math.min(totalMb * 0.5, Math.max(512, freeMb - 1024) * 0.7) / 256,
      ) * 256,
    ),
  );
}

export function safeExtractZip(
  zip: AdmZip,
  destination: string,
  filter: (name: string) => boolean = () => true,
): void {
  const base = path.resolve(destination);
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, "/");
    if (!filter(name)) continue;
    if (
      name.startsWith("/") ||
      /^[a-z]:/i.test(name) ||
      name.split("/").includes("..")
    )
      throw new Error("压缩包包含不安全路径");
    const target = path.resolve(base, name);
    if (target !== base && !target.startsWith(base + path.sep))
      throw new Error("压缩包路径越界");
    if (entry.isDirectory) {
      require("node:fs").mkdirSync(target, { recursive: true });
      continue;
    }
    require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
    require("node:fs").writeFileSync(target, entry.getData());
  }
}

export class JavaManager {
  private provisioning = new Map<number, Promise<string>>();
  constructor(
    private dataDir: string,
    private emit: Emit = () => {},
    private downloads = new DownloadManager(dataDir, emit),
  ) {}

  async inspect(executable: string): Promise<JavaInstallation | null> {
    try {
      const probe = javaExecutables(executable)[0];
      if (!probe) return null;
      const result = await runProcess(
        probe,
        ["-XshowSettings:properties", "-version"],
        undefined,
        undefined,
        15000,
      );
      const text = result.stderr + result.stdout;
      const info = parseJavaInstallation(text, probe);
      if (!info) return null;
      // Resolve Oracle javapath and javaw aliases to the actual JVM, so process
      // ownership and stop actions track the game instead of a short-lived shim.
      const actual = realJavaExecutable(info);
      if (actual && (await fs.stat(actual).catch(() => null))?.isFile())
        info.path = await fs.realpath(actual);
      else if (path.isAbsolute(probe)) info.path = await fs.realpath(probe);
      return info;
    } catch {
      return null;
    }
  }

  private async runtimeCandidates(root: string, depth = 2): Promise<string[]> {
    const candidates: string[] = [];
    const queue = [{ directory: root, level: 0 }];
    for (let cursor = 0; cursor < queue.length && cursor < 512; cursor++) {
      const { directory, level } = queue[cursor];
      const executable = path.join(
        directory,
        "bin",
        process.platform === "win32" ? "java.exe" : "java",
      );
      if (executable && (await fs.stat(executable).catch(() => null))?.isFile())
        candidates.push(executable);
      if (level >= depth) continue;
      const children = await fs
        .readdir(directory, { withFileTypes: true })
        .catch(() => []);
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith(".")) continue;
        queue.push({
          directory: path.join(directory, child.name),
          level: level + 1,
        });
      }
    }
    return candidates;
  }

  async discover(): Promise<JavaInstallation[]> {
    const candidates = new Set<string>(["java"]);
    for (const value of [process.env.JAVA_HOME, process.env.JDK_HOME])
      if (value)
        for (const executable of javaExecutables(value))
          candidates.add(executable);
    for (const directory of (process.env.PATH || process.env.Path || "").split(
      path.delimiter,
    )) {
      const selected = directory.trim().replace(/^"(.*)"$/, "$1");
      if (selected && path.isAbsolute(selected))
        candidates.add(
          path.join(
            selected,
            process.platform === "win32" ? "java.exe" : "java",
          ),
        );
    }
    const roots = [
      path.join(this.dataDir, "runtime"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Java"),
      path.join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Eclipse Adoptium",
      ),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft"),
      path.join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Amazon Corretto",
      ),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Zulu"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "BellSoft"),
      path.join(os.homedir(), ".jdks"),
      path.join(os.homedir(), ".jabba", "jdk"),
      path.join(os.homedir(), "scoop", "apps", "temurin-jdk"),
      ...(process.env.APPDATA
        ? [path.join(process.env.APPDATA, ".minecraft", "runtime")]
        : []),
    ];
    for (const root of roots) {
      for (const candidate of await this.runtimeCandidates(root, 3))
        candidates.add(candidate);
    }
    const list = [...candidates];
    let cursor = 0;
    const found: JavaInstallation[] = [];
    await Promise.all(
      Array.from({ length: Math.min(4, list.length) }, async () => {
        while (cursor < list.length) {
          const candidate = list[cursor++];
          if (
            path.isAbsolute(candidate) &&
            !(await fs.stat(candidate).catch(() => null))?.isFile()
          )
            continue;
          const info = await this.inspect(candidate);
          if (info) found.push(info);
        }
      }),
    );
    return [
      ...new Map(
        found.map((item) => [
          process.platform === "win32" ? item.path.toLowerCase() : item.path,
          item,
        ]),
      ).values(),
    ];
  }

  async ensure(major: number, override?: string): Promise<string> {
    if (!Number.isSafeInteger(major) || major <= 0 || major > 999)
      throw new Error("无效的 Java 主版本号");
    if (override?.trim()) {
      const custom = await this.inspect(override.trim());
      if (!custom) throw new Error("指定的 Java 无法运行，请检查 Java 路径");
      if (custom.major !== major)
        throw new Error(
          `当前版本需要 Java ${major}，指定的 Java 为 ${custom.major}；清空自定义路径可自动补齐`,
        );
      if (!compatibleJavaArchitecture(custom))
        throw new Error(
          `指定 Java 架构为 ${custom.architecture}，当前启动器需要 ${process.arch}；请清空自定义路径或选择匹配架构的 Java`,
        );
      return custom.path;
    }
    const pending = this.provisioning.get(major);
    if (pending) return pending;
    const operation = this.ensureAutomatic(major);
    this.provisioning.set(major, operation);
    try {
      return await operation;
    } finally {
      this.provisioning.delete(major);
    }
  }

  private async ensureAutomatic(major: number): Promise<string> {
    const available = await this.discover();
    // Prefer a concrete executable to Oracle's PATH shim, which starts a
    // second process and otherwise leaves the game alive when the shim exits.
    const exact =
      available.find(
        (item) =>
          item.major === major &&
          compatibleJavaArchitecture(item) &&
          path.isAbsolute(item.path),
      ) ||
      available.find(
        (item) => item.major === major && compatibleJavaArchitecture(item),
      );
    if (exact) return exact.path;
    const architecture =
      process.arch === "arm64"
        ? "aarch64"
        : process.arch === "ia32"
          ? "x86"
          : "x64";
    const archive = path.join(
      this.dataDir,
      "runtime",
      `java-${major}-${architecture}.zip`,
    );
    const installPackage = async (
      url: string,
      size: number | undefined,
      checksum: string | undefined,
    ) => {
      if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum))
        throw new Error("Java 下载源未提供有效 SHA-256 校验值");
      await this.downloads.downloadVerified(
        { url, path: archive, sha256: checksum, size, requireHttps: true },
        `自动补齐 Java ${major}`,
      );
    };
    let firstError: unknown;
    try {
      const packages = await requestJson<any[]>(
        `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${architecture}&image_type=jre&os=windows&vendor=eclipse`,
      );
      const binary = packages.find(
        (item) => item.binary?.package?.link,
      )?.binary;
      if (!binary) throw new Error("Adoptium 未提供此 Java 版本");
      await installPackage(
        binary.package.link,
        binary.package.size,
        binary.package.checksum,
      );
    } catch (error) {
      firstError = error;
      try {
        const azulArch = architecture === "x64" ? "x86_64" : architecture;
        const packages = await requestJson<any[]>(
          `https://api.azul.com/metadata/v1/zulu/packages/?java_version=${major}&os=windows&arch=${azulArch}&archive_type=zip&java_package_type=jre&release_status=ga&latest=true`,
        );
        const selected =
          packages.find((item) => !item.name?.includes("-fx-")) || packages[0];
        if (!selected?.package_uuid) throw new Error("Azul 未提供此 Java 版本");
        const details = await requestJson<any>(
          `https://api.azul.com/metadata/v1/zulu/packages/${encodeURIComponent(selected.package_uuid)}/`,
        );
        // Azul's metadata can contain a rounded byte count; the full SHA-256
        // digest is authoritative for archive integrity.
        await installPackage(
          details.download_url,
          undefined,
          details.sha256_hash,
        );
      } catch {
        throw new Error(
          `无法自动获取 Java ${major}，请检查网络或在设置中选择本地 Java。${String(firstError)}`,
        );
      }
    }
    const runtimeRoot = path.join(this.dataDir, "runtime");
    const staging = path.join(runtimeRoot, `.java-${major}-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      safeExtractZip(new AdmZip(archive), staging);
      let selected: JavaInstallation | undefined;
      for (const executable of await this.runtimeCandidates(staging, 3)) {
        const info = await this.inspect(executable);
        if (
          info?.major === major &&
          compatibleJavaArchitecture(info) &&
          path.isAbsolute(info.path)
        ) {
          const relative = path.relative(staging, info.path);
          if (
            relative &&
            !relative.startsWith(".." + path.sep) &&
            !path.isAbsolute(relative)
          ) {
            selected = info;
            break;
          }
        }
      }
      if (!selected)
        throw new Error(`Java ${major} 已解压，但无法执行或架构不匹配`);
      const destination = path.join(
        runtimeRoot,
        `java-${major}-${architecture}-${randomUUID().slice(0, 8)}`,
      );
      const relative = path.relative(staging, selected.path);
      await fs.rename(staging, destination);
      return path.join(destination, relative);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rm(archive, { force: true });
    }
  }
}
