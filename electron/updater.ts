import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  LauncherUpdateAttempt,
  LauncherUpdateState,
} from "../shared/updates";
import { UPDATE_HELPER } from "./update-helper";
export { UPDATE_HELPER } from "./update-helper";

export const RELEASE_PAGE = "https://github.com/KaMuMom/LDFCL/releases/latest";
const LATEST_API = "https://api.github.com/repos/KaMuMom/LDFCL/releases/latest";
const MAXIMUM_DOWNLOAD = 400 * 1024 * 1024;

export function stableVersion(value: unknown): number[] | undefined {
  if (typeof value !== "string" || !/^v?\d+\.\d+\.\d+$/.test(value)) return;
  const parts = value.replace(/^v/, "").split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return;
  return parts;
}

export function newerVersion(candidate: string, current: string): boolean {
  const a = stableVersion(candidate),
    b = stableVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

interface UpdateAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string;
}
export interface UpdateRelease {
  version: string;
  url: string;
  asset: UpdateAsset;
  checksum?: UpdateAsset;
}

function releaseAssetUrl(value: unknown, tag: string, name: string): string {
  const expected = `https://github.com/KaMuMom/LDFCL/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  if (value !== expected)
    throw Error("发行版下载地址无效，请前往 GitHub 查看。");
  return expected;
}

export function parseRelease(data: any): UpdateRelease {
  if (!data || data.draft || data.prerelease || !stableVersion(data.tag_name))
    throw Error("GitHub Latest 不是有效的正式发行版。");
  const version = data.tag_name.replace(/^v/, "");
  const name = `LDFCL-${version}-Windows-x64.exe`;
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const raw = assets.find((asset: any) => asset?.name === name);
  if (
    !raw ||
    !Number.isSafeInteger(raw.size) ||
    raw.size < 2 ||
    raw.size > MAXIMUM_DOWNLOAD
  )
    throw Error("该发行版暂未提供 Windows x64 更新文件。");
  const asset = {
    ...raw,
    browser_download_url: releaseAssetUrl(
      raw.browser_download_url,
      data.tag_name,
      name,
    ),
  };
  const checksumName = `SHA256SUMS-${version}.txt`;
  const sums = assets.find((entry: any) => entry?.name === checksumName);
  const checksum = sums && {
    ...sums,
    browser_download_url: releaseAssetUrl(
      sums.browser_download_url,
      data.tag_name,
      checksumName,
    ),
  };
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || "") && !checksum)
    throw Error("发行版缺少 SHA-256 校验信息，暂不能在应用内更新。");
  return {
    version,
    url: `https://github.com/KaMuMom/LDFCL/releases/tag/${encodeURIComponent(data.tag_name)}`,
    asset,
    checksum,
  };
}

function safeRequestUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    ![
      "api.github.com",
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(url.hostname)
  )
    throw Error("更新下载地址不受支持。");
  return url;
}

async function response(
  url: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<import("node:http").IncomingMessage> {
  if (redirects > 5) throw Error("更新服务器重定向次数过多。");
  const target = safeRequestUrl(url);
  return new Promise((resolve, reject) => {
    const request = https.get(
      target,
      {
        signal,
        headers: {
          "User-Agent": "LDFCL-Updater",
          Accept: "application/vnd.github+json",
        },
      },
      (incoming) => {
        const code = incoming.statusCode || 0;
        if (
          [301, 302, 303, 307, 308].includes(code) &&
          incoming.headers.location
        ) {
          incoming.resume();
          response(
            new URL(incoming.headers.location, target).href,
            signal,
            redirects + 1,
          ).then(resolve, reject);
        } else if (code !== 200) {
          incoming.resume();
          reject(
            Error(
              code === 403 || code === 429
                ? "GitHub 请求暂时受限，请稍后检查更新。"
                : `更新服务器返回 HTTP ${code}。`,
            ),
          );
        } else resolve(incoming);
      },
    );
    request.setTimeout(30000, () =>
      request.destroy(Error("更新服务器连接超时。")),
    );
    request.on("error", reject);
  });
}

export async function fetchUpdateText(
  url: string,
  maximum = 1024 * 1024,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const incoming = await response(url, controller.signal);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const raw of incoming) {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > maximum) {
        incoming.destroy();
        throw Error("更新信息超过大小限制。");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

export function checksumFor(release: UpdateRelease, sums?: string): string {
  if (/^sha256:[a-f0-9]{64}$/i.test(release.asset.digest || ""))
    return release.asset.digest!.slice(7).toLowerCase();
  for (const line of (sums || "").split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match?.[2] === release.asset.name) return match[1].toLowerCase();
  }
  throw Error("没有找到对应更新文件的 SHA-256 校验值。");
}

export async function downloadUpdate(
  release: UpdateRelease,
  target: string,
  expected: string,
  progress: (received: number, total: number) => void,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw Error("无效的更新校验值。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created = false;
  try {
    handle = await fs.open(target, "wx");
    created = true;
    const incoming = await response(
      release.asset.browser_download_url,
      controller.signal,
    );
    const hash = createHash("sha256");
    let bytes = 0,
      header = Buffer.alloc(0),
      lastProgress = 0;
    for await (const raw of incoming) {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > release.asset.size || bytes > MAXIMUM_DOWNLOAD) {
        incoming.destroy();
        throw Error("更新文件大小不符。");
      }
      if (header.length < 2)
        header = Buffer.concat([header, chunk]).subarray(0, 2);
      hash.update(chunk);
      await handle.writeFile(chunk);
      if (Date.now() - lastProgress > 150) {
        progress(bytes, release.asset.size);
        lastProgress = Date.now();
      }
    }
    if (bytes !== release.asset.size || header.toString("ascii") !== "MZ")
      throw Error("更新文件不完整或不是 Windows 程序。");
    if (hash.digest("hex") !== expected.toLowerCase())
      throw Error("更新文件 SHA-256 校验失败，请重新下载。");
    await handle.sync();
    progress(bytes, release.asset.size);
  } catch (error) {
    await handle?.close();
    handle = undefined;
    if (created) await fs.unlink(target).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    await handle?.close();
  }
}

export interface UpdateTransaction {
  schema: 1;
  id: string;
  nonce: string;
  target: string;
  staged: string;
  backup: string;
  expected: string;
  version: string;
  launcherPid: number;
  arguments: string[];
  exitTimeoutMs: number;
  replaceTimeoutMs: number;
  healthTimeoutMs: number;
  healthGraceMs: number;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const updateRoot = (executable: string) =>
  path.join(path.dirname(executable), ".ldfcl-update");

async function readJson(file: string): Promise<any> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw Error("更新事务文件无效。");
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function waitHelperReady(
  transactionFile: string,
  transaction: UpdateTransaction,
  timeout = 15000,
  failure?: () => string | undefined,
): Promise<void> {
  const folder = path.dirname(transactionFile);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const reason = failure?.();
    if (reason) throw Error(reason);
    try {
      const ready = await readJson(path.join(folder, "ready.json"));
      if (ready.id !== transaction.id || ready.nonce !== transaction.nonce)
        throw Error("更新助手握手不匹配。");
      return;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      const result = await readJson(path.join(folder, "result.json"));
      throw Error(`更新助手准备失败：${String(result.message).slice(0, 1200)}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await pause(100);
  }
  throw Error(
    "更新助手未在规定时间内确认就绪，当前启动器已保留。请重试或查看更新日志。",
  );
}

async function launchUpdateHelper(
  script: string,
  transactionFile: string,
  transaction: UpdateTransaction,
): Promise<void> {
  let failure: string | undefined;
  let diagnostic = "";
  const child = spawn(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      "-Transaction",
      transactionFile,
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      cwd: path.dirname(transaction.target),
    },
  );
  child.stderr?.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-2400);
  });
  child.once("error", (error) => {
    failure = error.message;
  });
  child.once("exit", (code) => {
    failure = `更新助手提前退出（代码 ${code}）。${diagnostic.trim()}`;
  });
  try {
    await waitHelperReady(transactionFile, transaction, 15000, () => failure);
  } finally {
    child.stderr?.destroy();
    child.unref();
  }
}

interface UpdaterOptions {
  currentVersion: string;
  executable?: string;
  emit: (state: LauncherUpdateState) => void;
  canInstall: () => Promise<void>;
  quit: () => void;
  fetchText?: typeof fetchUpdateText;
  download?: typeof downloadUpdate;
  launchHelper?: (script: string, arguments_: string[]) => Promise<void>;
  restartArguments?: string[];
  transactionTimeouts?: Partial<
    Pick<
      UpdateTransaction,
      "exitTimeoutMs" | "replaceTimeoutMs" | "healthTimeoutMs" | "healthGraceMs"
    >
  >;
}

export class LauncherUpdater {
  private value: LauncherUpdateState;
  private release?: UpdateRelease;
  private operation?: Promise<LauncherUpdateState>;
  private staged?: { file: string; expected: string; folder: string };
  private recoveryMessage?: string;
  constructor(private options: UpdaterOptions) {
    this.value = {
      status: "idle",
      currentVersion: options.currentVersion,
      releaseUrl: RELEASE_PAGE,
      supported: !!options.executable,
    };
  }
  state(): LauncherUpdateState {
    return { ...this.value };
  }
  private set(changes: Partial<LauncherUpdateState>) {
    this.value = { ...this.value, ...changes };
    this.options.emit(this.state());
  }
  async confirmStartup(): Promise<{ autoCheck: boolean }> {
    if (!this.options.executable) return { autoCheck: true };
    const root = updateRoot(this.options.executable);
    const transactionFile = process.env.LDFCL_UPDATE_TRANSACTION;
    const nonce = process.env.LDFCL_UPDATE_NONCE;
    delete process.env.LDFCL_UPDATE_TRANSACTION;
    delete process.env.LDFCL_UPDATE_NONCE;
    try {
      let confirmedResult: any;
      if (transactionFile || nonce) {
        const relative = path.relative(root, transactionFile || "");
        if (
          !relative ||
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          path.basename(transactionFile!) !== "transaction.json"
        )
          throw Error("更新启动回执路径无效。");
        const transaction = await readJson(transactionFile!);
        if (
          transaction.schema !== 1 ||
          transaction.nonce !== nonce ||
          !/^[a-f0-9]{64}$/.test(nonce || "") ||
          path.resolve(transaction.target).toLowerCase() !==
            path.resolve(this.options.executable).toLowerCase() ||
          transaction.version !== this.options.currentVersion
        )
          throw Error("更新启动信息与当前便携程序不匹配。");
        const folder = path.dirname(transactionFile!);
        await writeJsonAtomic(path.join(folder, "healthy.json"), {
          id: transaction.id,
          nonce,
          version: this.options.currentVersion,
          processId: process.pid,
        });
        const deadline = Date.now() + 15000;
        let completed = false;
        while (Date.now() < deadline) {
          try {
            confirmedResult = await readJson(path.join(folder, "result.json"));
            if (
              confirmedResult.id !== transaction.id ||
              confirmedResult.version !== transaction.version ||
              path.resolve(confirmedResult.target).toLowerCase() !==
                path.resolve(transaction.target).toLowerCase()
            )
              throw Error("更新结果与启动事务不匹配。");
            completed = true;
            break;
          } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
          }
          await pause(100);
        }
        if (!completed)
          throw Error(
            "新程序已启动，但更新助手尚未确认安装结果。请保留日志并重新打开启动器核对。",
          );
      }
      let result: any = confirmedResult;
      if (!result) {
        try {
          result = await readJson(path.join(root, "last-result.json"));
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        let pending: any;
        try {
          pending = await readJson(path.join(root, "pending.json"));
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (
          pending &&
          stableVersion(pending.version) &&
          newerVersion(pending.version, this.options.currentVersion) &&
          (!result ||
            (pending.id !== result.id &&
              Date.parse(pending.startedAt) > Date.parse(result.completedAt)))
        )
          result = {
            ...pending,
            status: "failed",
            completedAt: new Date().toISOString(),
            message: "上次更新助手未完成确认，当前版本已保留。",
          };
      }
      if (!result) return { autoCheck: true };
      if (
        !["installed", "failed", "rolled-back"].includes(result.status) ||
        !stableVersion(result.version) ||
        path.resolve(result.target).toLowerCase() !==
          path.resolve(this.options.executable).toLowerCase()
      )
        throw Error("上次更新结果文件无效。");
      if (
        result.status === "installed" &&
        result.version !== this.options.currentVersion
      )
        return { autoCheck: true };
      const message =
        result.status === "installed"
          ? `已成功更新至 ${result.version}，旧程序备份已保留。`
          : `${result.status === "rolled-back" ? "上次更新启动失败，已恢复原版本。" : "上次更新未完成，当前程序已保留。"} ${String(result.message || "请重新检查更新。").slice(0, 1200)}`;
      const attempt: LauncherUpdateAttempt = {
        id: String(result.id),
        status: result.status,
        version: result.version,
        completedAt: String(result.completedAt),
        message,
        logPath:
          typeof result.logPath === "string" ? result.logPath : undefined,
      };
      this.recoveryMessage = message;
      this.set({
        status: result.status === "installed" ? "current" : "error",
        message,
        lastAttempt: attempt,
      });
      return { autoCheck: result.status === "installed" };
    } catch (error) {
      this.recoveryMessage =
        error instanceof Error ? error.message : "暂时无法核对上次更新结果。";
      this.set({ status: "error", message: this.recoveryMessage });
      return { autoCheck: false };
    }
  }
  check(): Promise<LauncherUpdateState> {
    if (this.operation) return this.operation;
    if (["ready", "installing"].includes(this.value.status))
      return Promise.resolve(this.state());
    this.operation = (async () => {
      this.set({ status: "checking", message: this.recoveryMessage });
      try {
        const release = parseRelease(
          JSON.parse(
            await (this.options.fetchText || fetchUpdateText)(LATEST_API),
          ),
        );
        this.release = release;
        const hasUpdate = newerVersion(
          release.version,
          this.options.currentVersion,
        );
        this.set({
          status: hasUpdate ? "available" : "current",
          hasUpdate,
          latestVersion: release.version,
          releaseUrl: release.url,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        this.set({
          status: "error",
          message:
            error instanceof Error ? error.message : "暂时无法检查更新。",
        });
      }
      return this.state();
    })().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  download(): Promise<LauncherUpdateState> {
    if (this.operation) return this.operation;
    if (["ready", "installing"].includes(this.value.status))
      return Promise.resolve(this.state());
    this.operation = (async () => {
      let folder: string | undefined;
      try {
        if (!this.options.executable)
          throw Error("此环境不支持应用内更新，请从 GitHub 下载便携版。");
        if (
          !this.release ||
          !newerVersion(this.release.version, this.options.currentVersion)
        )
          throw Error("请先检查可用的新版本。");
        this.set({
          status: "downloading",
          message: undefined,
          lastAttempt: undefined,
          receivedBytes: 0,
          totalBytes: this.release.asset.size,
        });
        const parent = path.join(
          path.dirname(this.options.executable),
          ".ldfcl-update",
        );
        await fs.mkdir(parent, { recursive: true });
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw Error("更新缓存目录无效。");
        folder = path.join(parent, randomUUID());
        await fs.mkdir(folder);
        const expected = checksumFor(
          this.release,
          this.release.checksum &&
            !/^sha256:[a-f0-9]{64}$/i.test(this.release.asset.digest || "")
            ? await (this.options.fetchText || fetchUpdateText)(
                this.release.checksum.browser_download_url,
                65536,
              )
            : undefined,
        );
        const file = path.join(folder, "LDFCL-update.exe");
        await (this.options.download || downloadUpdate)(
          this.release,
          file,
          expected,
          (receivedBytes, totalBytes) =>
            this.set({ receivedBytes, totalBytes }),
        );
        this.staged = { file, expected, folder };
        this.set({
          status: "ready",
          message: "更新已下载并校验，重启后生效。",
        });
      } catch (error) {
        if (folder)
          await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
        this.set({
          status: "error",
          message:
            error instanceof Error ? error.message : "更新下载失败，请重试。",
        });
      }
      return this.state();
    })().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  async install(): Promise<LauncherUpdateState> {
    if (
      this.operation ||
      this.value.status !== "ready" ||
      !this.staged ||
      !this.options.executable
    )
      throw Error("请先完成更新下载。");
    const { folder, file, expected } = this.staged;
    const attemptFolder = path.join(folder, randomUUID());
    const helper = path.join(attemptFolder, "install.ps1");
    const transactionFile = path.join(attemptFolder, "transaction.json");
    this.set({ status: "installing", message: "正在退出并应用更新…" });
    try {
      await this.options.canInstall();
      const stat = await fs.lstat(this.options.executable);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error("当前程序不是可替换的便携版文件。");
      await fs.mkdir(attemptFolder);
      const transaction: UpdateTransaction = {
        schema: 1,
        id: randomUUID(),
        nonce: randomBytes(32).toString("hex"),
        target: this.options.executable,
        staged: file,
        backup: path.join(attemptFolder, "LDFCL-previous.exe"),
        expected,
        version: this.release!.version,
        launcherPid: process.pid,
        arguments:
          this.options.restartArguments ||
          process.argv
            .slice(1)
            .filter((arg) =>
              /^--(?:user-data-dir|remote-debugging-port)=/.test(arg),
            ),
        exitTimeoutMs: 60000,
        replaceTimeoutMs: 60000,
        healthTimeoutMs: 90000,
        healthGraceMs: 2000,
        ...this.options.transactionTimeouts,
      };
      await fs.writeFile(transactionFile, JSON.stringify(transaction), {
        flag: "wx",
      });
      await fs.writeFile(helper, "\ufeff" + UPDATE_HELPER, { flag: "wx" });
      await writeJsonAtomic(
        path.join(updateRoot(this.options.executable), "pending.json"),
        {
          id: transaction.id,
          version: transaction.version,
          target: transaction.target,
          transactionFile,
          startedAt: new Date().toISOString(),
        },
      );
      if (this.options.launchHelper) {
        await this.options.launchHelper(helper, [
          "-Transaction",
          transactionFile,
        ]);
        await waitHelperReady(transactionFile, transaction);
      } else await launchUpdateHelper(helper, transactionFile, transaction);
      this.options.quit();
    } catch (error) {
      await fs
        .writeFile(path.join(attemptFolder, "cancel"), "cancel")
        .catch(() => {});
      this.set({
        status: "ready",
        message: `更新助手未能就绪，当前程序保持运行。${error instanceof Error ? error.message : "请重试或从 GitHub 下载。"}`,
      });
      throw error;
    }
    return this.state();
  }
}
