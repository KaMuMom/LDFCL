import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { LauncherUpdateState } from "../shared/updates";

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

// Parameters are passed as process arguments; user paths are never interpolated into script code.
export const UPDATE_HELPER = `param([string]$Target,[string]$Staged,[string]$Backup,[string]$Expected,[int]$LauncherPid)
$ErrorActionPreference = 'Stop'
$Log = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($Staged), 'update.log')
function Test-UpdateHash {
  $Stream = [System.IO.File]::OpenRead($Staged)
  $Hasher = [System.Security.Cryptography.SHA256]::Create()
  try { $Actual = [System.BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Hasher.Dispose() }
  if ($Actual -ne $Expected) { throw 'Update checksum mismatch' }
}
try {
  Test-UpdateHash
  $Parent = $null
  try { $Parent = [System.Diagnostics.Process]::GetProcessById($LauncherPid) } catch {}
  if ($Parent) { $Parent.WaitForExit() }
  Test-UpdateHash
  $Moved = $false
  for ($Attempt = 0; $Attempt -lt 120; $Attempt++) {
    try { [System.IO.File]::Move($Target, $Backup); $Moved = $true; break }
    catch { [System.Threading.Thread]::Sleep(500) }
  }
  if (-not $Moved) { throw 'Could not replace launcher; original file was kept' }
  try { [System.IO.File]::Move($Staged, $Target) }
  catch { [System.IO.File]::Move($Backup, $Target); throw }
  try {
    $Start = New-Object System.Diagnostics.ProcessStartInfo
    $Start.FileName = $Target
    $Start.WorkingDirectory = [System.IO.Path]::GetDirectoryName($Target)
    $Start.UseShellExecute = $false
    $Start.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($Start) | Out-Null
  }
  catch {
    [System.IO.File]::Move($Target, $Staged)
    [System.IO.File]::Move($Backup, $Target)
    throw
  }
  [System.IO.File]::WriteAllText($Log, 'Update installed; previous launcher retained as backup')
} catch {
  [System.IO.File]::WriteAllText($Log, $_.Exception.Message)
}
`;

interface UpdaterOptions {
  currentVersion: string;
  executable?: string;
  emit: (state: LauncherUpdateState) => void;
  canInstall: () => Promise<void>;
  quit: () => void;
  fetchText?: typeof fetchUpdateText;
  download?: typeof downloadUpdate;
  launchHelper?: (script: string, arguments_: string[]) => Promise<void>;
}

export class LauncherUpdater {
  private value: LauncherUpdateState;
  private release?: UpdateRelease;
  private operation?: Promise<LauncherUpdateState>;
  private staged?: { file: string; expected: string; folder: string };
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
  check(): Promise<LauncherUpdateState> {
    if (this.operation) return this.operation;
    if (["ready", "installing"].includes(this.value.status))
      return Promise.resolve(this.state());
    this.operation = (async () => {
      this.set({ status: "checking", message: undefined });
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
    const helper = path.join(folder, "install.ps1");
    this.set({ status: "installing", message: "正在退出并应用更新…" });
    let helperCreated = false;
    try {
      await this.options.canInstall();
      const stat = await fs.lstat(this.options.executable);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error("当前程序不是可替换的便携版文件。");
      await fs.writeFile(helper, "\ufeff" + UPDATE_HELPER, { flag: "wx" });
      helperCreated = true;
      const arguments_ = [
        "-Target",
        this.options.executable,
        "-Staged",
        file,
        "-Backup",
        path.join(folder, "LDFCL-previous.exe"),
        "-Expected",
        expected,
        "-LauncherPid",
        String(process.pid),
      ];
      if (this.options.launchHelper)
        await this.options.launchHelper(helper, arguments_);
      else
        await new Promise<void>((resolve, reject) => {
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
              helper,
              ...arguments_,
            ],
            { detached: true, stdio: "ignore", windowsHide: true },
          );
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
      this.options.quit();
    } catch (error) {
      if (helperCreated) await fs.unlink(helper).catch(() => {});
      this.set({
        status: "ready",
        message: "无法启动更新助手，请重试或从 GitHub 下载。",
      });
      throw error;
    }
    return this.state();
  }
}
