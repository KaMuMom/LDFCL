import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import { safeStorage } from "electron";
import type { Account } from "../../shared/types";
import { AccountLifecycle, type AccountLease } from "./accountLifecycle";

type Emit = (event: any) => void;
type SecretFields = Pick<
  Account,
  "accessToken" | "refreshToken" | "clientToken"
>;
type StoredAccount = Omit<Account, keyof SecretFields> & {
  encryptedSecrets?: string;
};
type AuthorizedAccount = { account: Account; lease: AccountLease };
type MicrosoftToken = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

const MC = "https://api.minecraftservices.com";
const OAUTH = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const SCOPE = "XboxLive.signin offline_access";
const CALLBACK_PATH = "/oauth/callback";
const MICROSOFT_PORT = 45329;
export const MICROSOFT_REDIRECT_URI = `http://127.0.0.1:${MICROSOFT_PORT}${CALLBACK_PATH}`;
export type MicrosoftBrowserChallenge = {
  flow: "browser";
  authorizationUrl: string;
  expiresIn: number;
};
export type MicrosoftDeviceChallenge = {
  flow: "device";
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  interval: number;
};
type DeviceSession = {
  run: number;
  clientId: string;
  abort: AbortController;
  deviceCode?: string;
  expiresAt: number;
  intervalMs: number;
  challenge?: MicrosoftDeviceChallenge;
  timeout?: ReturnType<typeof setTimeout>;
};
type BrowserSession = {
  run: number;
  clientId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  server: Server;
  abort: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  consumed: boolean;
};

function callbackPage(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    Connection: "close",
  });
  // Only fixed application text is used here; OAuth query/body values are never rendered.
  response.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LDFCL · Microsoft 登录</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#edf3ee;color:#304c3b;font:16px/1.8 "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:440px;margin:24px;padding:40px;border:1px solid white;border-radius:24px;background:#ffffffd9;box-shadow:0 20px 80px #385b3412}small{color:#7b9985;letter-spacing:3px}h1{font-size:25px;margin:16px 0}p{color:#728576}</style><main><small>LDFCL</small><h1>${title}</h1><p>${message}</p></main></html>`,
  );
}

function stateMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual, "utf8"),
    right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Java UUID.nameUUIDFromBytes("OfflinePlayer:" + playerName). */
export function offlineUuid(name: string): string {
  const bytes = createHash("md5")
    .update(`OfflinePlayer:${name}`, "utf8")
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString("hex");
}

function publicAccount(account: Account): Account {
  const {
    accessToken: _access,
    refreshToken: _refresh,
    clientToken: _client,
    ...clean
  } = account;
  return clean as Account;
}

function serverUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      "请输入完整的皮肤站 API 地址，例如 https://skin.example.com/api/yggdrasil",
    );
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "皮肤站地址必须是 HTTP(S) API 地址，不能包含凭据、查询参数或片段。",
    );
  }
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(
      "皮肤站登录需要 HTTPS，以保护密码；本机调试地址可以使用 HTTP。",
    );
  }
  return url.href.replace(/\/+$/, "");
}

class AccountNetworkError extends Error {}

function requireVerifiedTls(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error(
      "检测到 NODE_TLS_REJECT_UNAUTHORIZED=0，账号登录已停止。请删除此环境变量并重新启动 LDFCL，以恢复 HTTPS 证书验证。",
    );
}

function certificateFailure(error: any): boolean {
  for (let depth = 0; error && depth < 5; depth++, error = error.cause) {
    if (
      typeof error.code === "string" &&
      /CERT|TLS|SSL|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER/.test(
        error.code,
      )
    )
      return true;
  }
  return false;
}

async function accountResponse(
  url: string,
  init: RequestInit = {},
  service = "账号服务",
): Promise<{ response: Response; body: any }> {
  requireVerifiedTls();
  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      redirect: "error",
    });
    raw = await response.text();
  } catch (error: any) {
    if (certificateFailure(error))
      throw new Error(
        `${service}的 HTTPS 证书验证失败，已停止登录。请检查系统时间、受信任证书或代理设置后重试。`,
      );
    if (error?.name === "AbortError" || error?.name === "TimeoutError")
      throw new AccountNetworkError(`${service}请求超时，请检查网络后重试。`);
    throw new AccountNetworkError(`${service}连接失败，请检查网络或代理设置。`);
  }
  let body: any = {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = {};
    }
  }
  if (!body || typeof body !== "object") body = {};
  return { response, body };
}

async function request(
  url: string,
  init: RequestInit = {},
  service = "账号服务",
): Promise<any> {
  const { response, body } = await accountResponse(url, init, service);
  if (!response.ok) {
    const status = Number(body.XErr);
    if (status === 2148916233)
      throw new Error(
        "此 Microsoft 账号尚未创建 Xbox 档案，请先登录 xbox.com 完成初始化。",
      );
    if (status === 2148916238)
      throw new Error(
        "此 Xbox 账号受家庭或年龄限制，需要监护人在 Xbox 家庭设置中授权。",
      );
    if (status === 2148916235)
      throw new Error("此 Xbox 账号所在地区无法使用 Xbox Live。");
    if (url.endsWith("/minecraft/profile") && response.status === 404)
      throw new Error(
        "此账号尚无 Minecraft Java 档案，请确认已购买 Java 版并设置游戏名。",
      );
    if (response.status === 401 || response.status === 403)
      throw new Error(
        `${service}授权失败（HTTP ${response.status}），请重新登录或检查应用授权。`,
      );
    throw new Error(`${service}请求失败（HTTP ${response.status}）。`);
  }
  return body;
}

function microsoftClientId(value: string): string {
  const clientId = String(value ?? "").trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      clientId,
    )
  )
    throw new Error(
      "请先在设置中填写你注册并获准访问 Minecraft API 的 Microsoft 公共客户端应用 ID，并启用个人账号登录及公共客户端授权。",
    );
  return clientId;
}

function deviceChallenge(body: any): MicrosoftDeviceChallenge {
  let verification: URL;
  try {
    verification = new URL(body.verification_uri);
  } catch {
    throw new Error("Microsoft 返回的设备登录地址无效，请重新发起登录。");
  }
  const microsoftHosts = [
    "microsoft.com",
    "www.microsoft.com",
    "login.microsoftonline.com",
    "login.live.com",
    "account.live.com",
  ];
  if (
    verification.protocol !== "https:" ||
    !microsoftHosts.includes(verification.hostname) ||
    verification.username ||
    verification.password ||
    verification.port ||
    verification.search ||
    verification.hash
  )
    throw new Error("Microsoft 返回的设备登录地址不受信任，已停止登录。");
  const interval = body.interval === undefined ? 5 : body.interval;
  if (
    typeof body.device_code !== "string" ||
    body.device_code.length < 8 ||
    body.device_code.length > 16_384 ||
    /[\u0000-\u0020\u007f]/.test(body.device_code) ||
    typeof body.user_code !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/.test(body.user_code) ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in < 1 ||
    body.expires_in > 3600 ||
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > 300
  )
    throw new Error("Microsoft 返回的设备授权信息无效，请重新发起登录。");
  return {
    flow: "device",
    verificationUri: verification.href,
    userCode: body.user_code,
    expiresIn: body.expires_in,
    interval,
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function jsonPost(
  url: string,
  body: any,
  service: string,
  token?: string,
  signal?: AbortSignal,
): Promise<any> {
  return request(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      ...(signal
        ? { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }
        : {}),
    },
    service,
  );
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Mojang's texture properties still advertise HTTP URLs; the same CDN supports HTTPS. */
export function normalizeTextureUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    if (url.hostname.toLowerCase() === "textures.minecraft.net")
      url.protocol = "https:";
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizeTextures(items: any): any[] {
  return Array.isArray(items)
    ? items.map((item) => ({ ...item, url: normalizeTextureUrl(item.url) }))
    : [];
}

export function validateSkinPng(buffer: Buffer): void {
  if (
    buffer.length < 24 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("皮肤文件必须是 PNG 图片。");
  }
  const width = buffer.readUInt32BE(16),
    height = buffer.readUInt32BE(20);
  if (width !== 64 || ![32, 64].includes(height))
    throw new Error("正版皮肤需要 64×64 或 64×32 像素 PNG。");
}

export class AccountService {
  private readonly file: string;
  private readonly ready: Promise<void>;
  private accounts: Account[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private microsoftRun = 0;
  private microsoftSession?: BrowserSession;
  private microsoftDeviceSession?: DeviceSession;
  private readonly lifecycle = new AccountLifecycle();
  private readonly launchAuth = new Map<string, Promise<AuthorizedAccount>>();

  constructor(
    private readonly dataDir: string,
    private readonly emit: Emit,
    private readonly options: {
      microsoftPort?: number;
      microsoftTimeoutMs?: number;
      deviceClock?: {
        now(): number;
        sleep(ms: number, signal: AbortSignal): Promise<void>;
      };
    } = {},
  ) {
    this.file = path.join(dataDir, "accounts.json");
    this.ready = this.load();
  }

  private secureStorageAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    let stored: StoredAccount[];
    try {
      stored = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error: any) {
      if (error.code !== "ENOENT")
        this.emit({
          type: "auth-status",
          status: "warning",
          message: "账号文件无法读取，已保留原文件。",
        });
      return;
    }
    if (!Array.isArray(stored)) return;
    for (const item of stored) {
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        !["offline", "microsoft", "yggdrasil"].includes(item.type)
      )
        continue;
      const { encryptedSecrets, ...metadata } = item;
      // Never read legacy plaintext token fields from disk.
      delete (metadata as any).accessToken;
      delete (metadata as any).refreshToken;
      delete (metadata as any).clientToken;
      let secret: SecretFields = {};
      if (encryptedSecrets && this.secureStorageAvailable()) {
        try {
          secret = JSON.parse(
            safeStorage.decryptString(Buffer.from(encryptedSecrets, "base64")),
          );
        } catch {
          /* Another Windows user or corrupt encrypted data: sign in again. */
        }
      }
      this.accounts.push({ ...metadata, ...secret } as Account);
      this.lifecycle.replace(item.id);
    }
  }

  private async writeSnapshot(
    accounts: Account[],
    isActive?: () => boolean,
  ): Promise<boolean> {
    const encrypted = this.secureStorageAvailable();
    const stored: StoredAccount[] = accounts.map((account) => {
      const metadata = publicAccount(account) as StoredAccount;
      if (encrypted && account.type !== "offline") {
        const secret: SecretFields = {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          clientToken: account.clientToken,
        };
        metadata.encryptedSecrets = safeStorage
          .encryptString(JSON.stringify(secret))
          .toString("base64");
      }
      return metadata;
    });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(stored, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (isActive && !isActive()) {
      await fs.rm(temporary, { force: true });
      return false;
    }
    await fs.rename(temporary, this.file);
    if (isActive && !isActive()) {
      // Cancellation during rename must leave the last committed accounts intact.
      await this.writeSnapshot(this.accounts);
      return false;
    }
    return true;
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await this.writeSnapshot(this.accounts);
      });
    return this.writeQueue;
  }

  private async save(account: Account): Promise<Account> {
    this.lifecycle.replace(account.id);
    this.launchAuth.delete(account.id);
    const lease = this.lifecycle.capture(account.id);
    const index = this.accounts.findIndex(
      (candidate) => candidate.id === account.id,
    );
    if (index < 0) this.accounts.push(account);
    else this.accounts[index] = account;
    await this.persist();
    lease.assertCurrent();
    return this.announceAccount(account);
  }

  private async updateAccount(
    lease: AccountLease,
    update: (current: Account) => Account,
  ): Promise<Account> {
    let updated: Account | undefined;
    const operation = this.writeQueue
      .catch(() => {})
      .then(async () => {
        lease.assertCurrent();
        const index = this.accounts.findIndex(
          (account) => account.id === lease.id,
        );
        if (index < 0) throw new Error("账号不存在，请重新选择账号。");
        const next = [...this.accounts];
        const account = update(next[index]);
        next[index] = account;
        if (!(await this.writeSnapshot(next, lease.isCurrent))) {
          lease.assertCurrent();
          throw new Error("账号更新未能保存，请重试。");
        }
        lease.assertCurrent();
        // Preserve unrelated changes made while the encrypted snapshot was written.
        const currentIndex = this.accounts.findIndex(
          (item) => item.id === lease.id,
        );
        this.accounts[currentIndex] = account;
        updated = account;
        this.announceAccount(account);
      });
    this.writeQueue = operation;
    await operation;
    return updated!;
  }

  private announceAccount(account: Account): Account {
    const clean = publicAccount(account);
    this.emit({ type: "account", account: clean });
    if (account.type !== "offline" && !this.secureStorageAvailable()) {
      this.emit({
        type: "auth-status",
        status: "warning",
        message:
          "系统安全存储不可用，本次授权仅保存在内存，退出后需要重新登录。",
      });
    }
    return clean;
  }

  private async saveMicrosoftAccount(
    account: Account,
    isActive: () => boolean,
  ): Promise<boolean> {
    let committed = false;
    const operation = this.writeQueue
      .catch(() => {})
      .then(async () => {
        if (!isActive()) return;
        const next = [...this.accounts];
        const index = next.findIndex(
          (candidate) => candidate.id === account.id,
        );
        if (index < 0) next.push(account);
        else next[index] = account;
        if (!(await this.writeSnapshot(next, isActive))) return;
        // Other account operations can run while the filesystem write is pending.
        const currentIndex = this.accounts.findIndex(
          (candidate) => candidate.id === account.id,
        );
        if (currentIndex < 0) this.accounts.push(account);
        else this.accounts[currentIndex] = account;
        this.lifecycle.replace(account.id);
        this.launchAuth.delete(account.id);
        committed = true;
        this.announceAccount(account);
      });
    this.writeQueue = operation;
    await operation;
    return committed;
  }

  async list(): Promise<Account[]> {
    await this.ready;
    return this.accounts.map(publicAccount);
  }

  async addOffline(name: string): Promise<Account> {
    await this.ready;
    name = name.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name))
      throw new Error("离线游戏名须为 3–16 位英文字母、数字或下划线。");
    const uuid = offlineUuid(name);
    const existing = this.accounts.find(
      (account) => account.type === "offline" && account.uuid === uuid,
    );
    if (existing) return publicAccount(existing);
    return this.save({ id: randomUUID(), type: "offline", name, uuid });
  }

  async remove(id: string): Promise<void> {
    await this.ready;
    this.lifecycle.remove(id);
    this.launchAuth.delete(id);
    this.accounts = this.accounts.filter((account) => account.id !== id);
    await this.persist();
    this.emit({ type: "account-removed", id });
  }

  private async accountContext(id: string): Promise<AuthorizedAccount> {
    await this.ready;
    const account = this.accounts.find((candidate) => candidate.id === id);
    if (!account) throw new Error("账号不存在，请重新选择账号。");
    return { account: { ...account }, lease: this.lifecycle.capture(id) };
  }

  private closeMicrosoftListener(session: BrowserSession, force = false): void {
    // Stop accepting new connections immediately. Graceful close preserves the callback page.
    try {
      session.server.close();
    } catch {
      /* Not listening yet or already closed. */
    }
    if (force) session.server.closeAllConnections();
    else session.server.closeIdleConnections();
    session.server.unref();
  }

  private finishMicrosoftSession(session: BrowserSession, force = true): void {
    if (session.timeout) clearTimeout(session.timeout);
    this.closeMicrosoftListener(session, force);
    session.abort.abort();
    if (this.microsoftSession === session) this.microsoftSession = undefined;
  }

  cancelMicrosoft(): void {
    const flows: ("browser" | "device")[] = [];
    this.microsoftRun++;
    if (this.microsoftSession) {
      flows.push("browser");
      this.finishMicrosoftSession(this.microsoftSession);
    }
    if (this.microsoftDeviceSession) {
      flows.push("device");
      this.finishMicrosoftDevice(this.microsoftDeviceSession);
    }
    for (const flow of flows)
      this.emit({
        type: "auth-status",
        flow,
        status: "cancelled",
        message: "Microsoft 登录已取消。",
      });
  }

  private deviceNow(): number {
    return this.options.deviceClock?.now() ?? Date.now();
  }

  private deviceActive(session: DeviceSession): boolean {
    return (
      this.microsoftDeviceSession === session &&
      session.run === this.microsoftRun &&
      !session.abort.signal.aborted
    );
  }

  private finishMicrosoftDevice(session: DeviceSession): void {
    if (session.timeout) clearTimeout(session.timeout);
    session.deviceCode = undefined;
    session.abort.abort();
    if (this.microsoftDeviceSession === session)
      this.microsoftDeviceSession = undefined;
  }

  private expireMicrosoftDevice(session: DeviceSession): void {
    if (!this.deviceActive(session)) return;
    this.finishMicrosoftDevice(session);
    this.emit({
      type: "auth-status",
      flow: "device",
      status: "expired",
      message: "Microsoft 设备登录代码已过期，请重新发起登录。",
    });
  }

  async beginMicrosoftDevice(
    clientId: string,
  ): Promise<MicrosoftDeviceChallenge> {
    clientId = microsoftClientId(clientId);
    requireVerifiedTls();
    this.cancelMicrosoft();
    const session: DeviceSession = {
      run: ++this.microsoftRun,
      clientId,
      abort: new AbortController(),
      expiresAt: 0,
      intervalMs: 5000,
    };
    this.microsoftDeviceSession = session;
    try {
      await this.ready;
      if (!this.deviceActive(session))
        throw new Error("此 Microsoft 登录请求已取消。");
      const issuedAt = this.deviceNow();
      const body = await request(
        `${OAUTH}/devicecode`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            scope: SCOPE,
          }).toString(),
          signal: AbortSignal.any([
            session.abort.signal,
            AbortSignal.timeout(30_000),
          ]),
        },
        "Microsoft 设备登录",
      );
      if (!this.deviceActive(session))
        throw new Error("此 Microsoft 登录请求已取消。");
      const challenge = deviceChallenge(body);
      session.challenge = challenge;
      session.deviceCode = body.device_code;
      session.intervalMs = challenge.interval * 1000;
      session.expiresAt = issuedAt + challenge.expiresIn * 1000;
      const remaining = session.expiresAt - this.deviceNow();
      if (remaining <= 0) {
        this.expireMicrosoftDevice(session);
        throw new Error("Microsoft 设备登录代码已过期，请重新发起登录。");
      }
      challenge.expiresIn = Math.ceil(remaining / 1000);
      // This independent timer also expires a flow whose HTTP request is hung.
      session.timeout = setTimeout(
        () => this.expireMicrosoftDevice(session),
        remaining,
      );
      session.timeout.unref?.();
      this.emit({
        type: "auth-status",
        status: "waiting",
        ...challenge,
        message: "请在 Microsoft 授权页面输入设备代码，完成授权后将自动继续。",
      });
      void this.pollMicrosoftDevice(session);
      return challenge;
    } catch (error: any) {
      if (this.deviceActive(session)) {
        this.finishMicrosoftDevice(session);
        this.emit({
          type: "auth-status",
          flow: "device",
          status: "error",
          message: error?.message ?? "Microsoft 设备登录失败，请重试。",
        });
      }
      throw error;
    }
  }

  private async pollMicrosoftDevice(session: DeviceSession): Promise<void> {
    let delay = session.intervalMs;
    try {
      while (this.deviceActive(session)) {
        const remaining = session.expiresAt - this.deviceNow();
        if (remaining <= 0) {
          this.expireMicrosoftDevice(session);
          return;
        }
        await (this.options.deviceClock?.sleep ?? abortableSleep)(
          Math.min(delay, remaining),
          session.abort.signal,
        );
        if (!this.deviceActive(session)) return;
        if (this.deviceNow() >= session.expiresAt) {
          this.expireMicrosoftDevice(session);
          return;
        }
        let result: { response: Response; body: any };
        try {
          result = await accountResponse(
            `${OAUTH}/token`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                client_id: session.clientId,
                device_code: session.deviceCode!,
              }).toString(),
              signal: AbortSignal.any([
                session.abort.signal,
                AbortSignal.timeout(30_000),
              ]),
            },
            "Microsoft 设备授权",
          );
        } catch (error) {
          if (!this.deviceActive(session)) return;
          if (!(error instanceof AccountNetworkError)) throw error;
          delay = Math.max(session.intervalMs, Math.min(60_000, delay * 2));
          this.emit({
            type: "auth-status",
            ...session.challenge,
            flow: "device",
            status: "waiting",
            expiresIn: Math.max(
              0,
              Math.ceil((session.expiresAt - this.deviceNow()) / 1000),
            ),
            interval: session.intervalMs / 1000,
            message:
              "Microsoft 暂时无法连接，将稍后重试；请检查网络或代理设置。",
          });
          continue;
        }
        if (!this.deviceActive(session)) return;
        const { response, body } = result;
        if (this.deviceNow() >= session.expiresAt) {
          this.expireMicrosoftDevice(session);
          return;
        }
        if (!response.ok && body.error === "slow_down") {
          session.intervalMs += 5000;
          delay = session.intervalMs;
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          delay = Math.max(session.intervalMs, Math.min(60_000, delay * 2));
          continue;
        }
        if (!response.ok) {
          if (body.error === "authorization_pending") {
            delay = session.intervalMs;
            continue;
          }
          if (body.error === "expired_token") {
            this.expireMicrosoftDevice(session);
            return;
          }
          throw new Error(
            ["authorization_declined", "access_denied"].includes(body.error)
              ? "你已取消或拒绝 Microsoft 设备登录授权。"
              : ["bad_verification_code", "invalid_grant"].includes(body.error)
                ? "Microsoft 设备登录代码已失效，请重新发起登录。"
                : "Microsoft 设备授权失败，请检查应用 ID、个人账号权限及公共客户端授权配置后重试。",
          );
        }
        if (
          typeof body.access_token !== "string" ||
          !body.access_token ||
          body.access_token.length > 32_768
        )
          throw new Error("Microsoft 未返回有效授权，请检查应用配置后重试。");
        this.emit({
          type: "auth-status",
          flow: "device",
          status: "authenticating",
          message: "Microsoft 授权完成，正在验证 Xbox 与 Minecraft 游戏授权…",
        });
        const account = await this.microsoftMinecraft(
          body,
          session.clientId,
          undefined,
          session.abort.signal,
        );
        if (!this.deviceActive(session)) return;
        if (
          !(await this.saveMicrosoftAccount(account, () =>
            this.deviceActive(session),
          ))
        )
          return;
        if (!this.deviceActive(session)) return;
        this.finishMicrosoftDevice(session);
        this.emit({
          type: "auth-status",
          flow: "device",
          status: "success",
          account: publicAccount(account),
          message: `已登录 ${account.name}`,
        });
        return;
      }
    } catch (error: any) {
      if (!this.deviceActive(session)) return;
      this.finishMicrosoftDevice(session);
      this.emit({
        type: "auth-status",
        flow: "device",
        status: "error",
        message: error?.message ?? "Microsoft 设备登录失败，请重试。",
      });
    }
  }

  async beginMicrosoft(clientId: string): Promise<MicrosoftBrowserChallenge> {
    clientId = microsoftClientId(clientId);
    requireVerifiedTls();
    const previous = this.microsoftSession;
    this.cancelMicrosoft();
    const run = ++this.microsoftRun;
    await this.ready;
    if (run !== this.microsoftRun)
      throw new Error("此 Microsoft 登录请求已取消。");
    if (previous) {
      this.finishMicrosoftSession(previous);
      // Let the operating system release the fixed registered callback port before rebinding.
      if (previous.server.listening)
        await new Promise<void>((resolve) =>
          previous.server.close(() => resolve()),
        );
    }
    const verifier = randomBytes(64).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const port = this.options.microsoftPort ?? MICROSOFT_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Microsoft 本机回调端口无效。");
    const timeoutMs = Math.max(1, this.options.microsoftTimeoutMs ?? 300_000);
    const server = createServer({ maxHeaderSize: 8192 });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 8;
    const session: BrowserSession = {
      run,
      clientId,
      state,
      verifier,
      redirectUri: "",
      server,
      abort: new AbortController(),
      consumed: false,
    };
    this.microsoftSession = session;
    server.on("request", (request, response) => {
      if (
        this.microsoftSession !== session ||
        run !== this.microsoftRun ||
        session.consumed
      ) {
        callbackPage(
          response,
          410,
          "本次登录已结束",
          "请返回 LDFCL 发起新的 Microsoft 登录。",
        );
        return;
      }
      let target: URL;
      try {
        target = new URL(request.url ?? "", session.redirectUri);
      } catch {
        callbackPage(response, 400, "无效的回调请求", "请返回启动器重试。");
        return;
      }
      const expected = new URL(session.redirectUri);
      if (
        request.headers.host !== expected.host ||
        target.origin !== expected.origin ||
        target.pathname !== CALLBACK_PATH
      ) {
        callbackPage(
          response,
          404,
          "没有这个页面",
          "请在 LDFCL 中发起 Microsoft 登录。",
        );
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        callbackPage(
          response,
          405,
          "请通过 Microsoft 授权页面继续",
          "此地址仅接收浏览器返回的授权表单。",
        );
        return;
      }
      if (
        target.search ||
        request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
          "application/x-www-form-urlencoded"
      ) {
        callbackPage(
          response,
          415,
          "授权响应格式无效",
          "请返回 LDFCL 重新登录。",
        );
        return;
      }
      const declaredSize = Number(request.headers["content-length"] ?? 0);
      if (
        !Number.isFinite(declaredSize) ||
        declaredSize < 0 ||
        declaredSize > 16_384
      ) {
        callbackPage(response, 413, "授权响应过大", "请返回启动器重试。");
        request.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0,
        rejected = false;
      request.on("data", (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > 16_384) {
          rejected = true;
          callbackPage(response, 413, "授权响应过大", "请返回启动器重试。");
          return;
        }
        chunks.push(chunk);
      });
      request.on("error", () => {
        if (!response.writableEnded)
          callbackPage(
            response,
            400,
            "授权回调未完成",
            "请返回启动器重新登录。",
          );
      });
      request.on("end", () => {
        if (rejected || response.writableEnded) return;
        if (
          this.microsoftSession !== session ||
          run !== this.microsoftRun ||
          session.consumed
        ) {
          callbackPage(response, 410, "本次登录已结束", "请返回 LDFCL 重试。");
          return;
        }
        const params = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (
          params.getAll("state").length !== 1 ||
          !stateMatches(params.get("state"), session.state)
        ) {
          callbackPage(
            response,
            403,
            "无法验证本次授权",
            "请回到最初由 LDFCL 打开的 Microsoft 页面完成登录，或取消后重试。",
          );
          return;
        }
        const code = params.get("code"),
          error = params.get("error");
        if (
          (code && error) ||
          params.getAll("code").length > 1 ||
          params.getAll("error").length > 1 ||
          (!code && !error) ||
          (code?.length ?? 0) > 12_000
        ) {
          callbackPage(
            response,
            400,
            "授权响应无效",
            "请返回 LDFCL 重新登录。",
          );
          return;
        }
        session.consumed = true;
        // The response is deliberately free of codes, tokens and provider error descriptions.
        response.once("finish", () => session.server.closeAllConnections());
        callbackPage(
          response,
          error ? 400 : 200,
          error ? "未完成 Microsoft 授权" : "已收到 Microsoft 授权",
          error
            ? "你可以关闭此页面，在 LDFCL 中重新登录。"
            : "正在完成 Xbox 与 Minecraft 验证，请回到 LDFCL 查看结果。你可以关闭此页面。",
        );
        this.closeMicrosoftListener(session);
        if (error) {
          const message =
            error === "access_denied"
              ? "你已取消或拒绝 Microsoft 登录授权。"
              : "Microsoft 登录未完成，请检查应用 ID、个人账号权限与注册的本机回调地址。";
          this.finishMicrosoftSession(session, false);
          this.emit({
            type: "auth-status",
            flow: "browser",
            status: "error",
            message,
          });
          return;
        }
        this.emit({
          type: "auth-status",
          flow: "browser",
          status: "authenticating",
          message: "Microsoft 授权完成，正在验证 Xbox 与 Minecraft 游戏授权…",
        });
        void this.redeemMicrosoftCode(session, code!);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) =>
          reject(
            new Error(
              error.code === "EADDRINUSE"
                ? `Microsoft 登录回调端口 ${port} 正在使用中。请关闭其他 LDFCL 登录窗口后重试；注册的回调地址必须保持一致。`
                : "无法创建 Microsoft 登录的本机回调，请检查防火墙或端口权限。",
            ),
          );
        server.once("error", onError);
        server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      if (run !== this.microsoftRun || this.microsoftSession !== session)
        throw new Error("此 Microsoft 登录请求已取消。");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("无法确定 Microsoft 登录回调端口。");
      session.redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      server.on("error", () => {
        if (this.microsoftSession !== session) return;
        this.finishMicrosoftSession(session);
        this.emit({
          type: "auth-status",
          flow: "browser",
          status: "error",
          message: "Microsoft 本机登录回调监听失败，请重试。",
        });
      });
      const authorization = new URL(`${OAUTH}/authorize`);
      authorization.search = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: session.redirectUri,
        response_mode: "form_post",
        scope: SCOPE,
        state,
        code_challenge: createHash("sha256")
          .update(verifier, "ascii")
          .digest("base64url"),
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      const challenge: MicrosoftBrowserChallenge = {
        flow: "browser",
        authorizationUrl: authorization.href,
        expiresIn: Math.ceil(timeoutMs / 1000),
      };
      session.timeout = setTimeout(() => {
        if (this.microsoftSession !== session) return;
        this.microsoftRun++;
        this.finishMicrosoftSession(session);
        this.emit({
          type: "auth-status",
          flow: "browser",
          status: "expired",
          message: "Microsoft 浏览器登录已超时，请重新发起登录。",
        });
      }, timeoutMs);
      session.timeout.unref?.();
      server.unref();
      this.emit({
        type: "auth-status",
        status: "waiting",
        ...challenge,
        message:
          "已在系统浏览器中打开 Microsoft 登录，完成账号授权后将自动返回启动器。",
      });
      return challenge;
    } catch (error) {
      this.finishMicrosoftSession(session);
      throw error;
    }
  }

  private async redeemMicrosoftCode(
    session: BrowserSession,
    code: string,
  ): Promise<void> {
    try {
      const token = await request(
        `${OAUTH}/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: session.clientId,
            redirect_uri: session.redirectUri,
            code,
            code_verifier: session.verifier,
            scope: SCOPE,
          }).toString(),
          signal: AbortSignal.any([
            session.abort.signal,
            AbortSignal.timeout(30_000),
          ]),
        },
        "Microsoft 授权交换",
      );
      if (!token.access_token)
        throw new Error("Microsoft 未返回有效授权，请检查应用配置后重试。");
      if (
        session.run !== this.microsoftRun ||
        this.microsoftSession !== session
      )
        return;
      const account = await this.microsoftMinecraft(
        token,
        session.clientId,
        undefined,
        session.abort.signal,
      );
      if (
        session.run !== this.microsoftRun ||
        this.microsoftSession !== session ||
        session.abort.signal.aborted
      )
        return;
      if (
        !(await this.saveMicrosoftAccount(
          account,
          () =>
            session.run === this.microsoftRun &&
            this.microsoftSession === session &&
            !session.abort.signal.aborted,
        ))
      )
        return;
      if (
        session.run !== this.microsoftRun ||
        this.microsoftSession !== session
      )
        return;
      this.finishMicrosoftSession(session);
      this.emit({
        type: "auth-status",
        flow: "browser",
        status: "success",
        account: publicAccount(account),
        message: `已登录 ${account.name}`,
      });
    } catch (error: any) {
      if (
        session.run !== this.microsoftRun ||
        this.microsoftSession !== session
      )
        return;
      this.finishMicrosoftSession(session);
      this.emit({
        type: "auth-status",
        flow: "browser",
        status: "error",
        message: error?.message ?? "Microsoft 登录失败，请重新登录。",
      });
    }
  }

  private async microsoftMinecraft(
    token: MicrosoftToken,
    clientId: string,
    previous?: Account,
    signal?: AbortSignal,
  ): Promise<Account> {
    const xbl = await jsonPost(
      "https://user.auth.xboxlive.com/user/authenticate",
      {
        Properties: {
          AuthMethod: "RPS",
          SiteName: "user.auth.xboxlive.com",
          RpsTicket: `d=${token.access_token}`,
        },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT",
      },
      "Xbox Live",
      undefined,
      signal,
    );
    const xsts = await jsonPost(
      "https://xsts.auth.xboxlive.com/xsts/authorize",
      {
        Properties: { SandboxId: "RETAIL", UserTokens: [xbl.Token] },
        RelyingParty: "rp://api.minecraftservices.com/",
        TokenType: "JWT",
      },
      "Xbox 授权",
      undefined,
      signal,
    );
    const userHash = xsts.DisplayClaims?.xui?.[0]?.uhs;
    if (!userHash || !xsts.Token)
      throw new Error("Xbox 未返回有效的账号授权。");
    const minecraft = await jsonPost(
      `${MC}/authentication/login_with_xbox`,
      {
        identityToken: `XBL3.0 x=${userHash};${xsts.Token}`,
        ensureLegacyEnabled: true,
      },
      "Minecraft 登录",
      undefined,
      signal,
    );
    if (!minecraft.access_token)
      throw new Error("Minecraft 未返回有效的访问令牌。");
    const ownership = await request(
      `${MC}/entitlements/mcstore`,
      {
        headers: bearer(minecraft.access_token),
        ...(signal
          ? { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }
          : {}),
      },
      "Minecraft 游戏所有权",
    );
    if (
      !Array.isArray(ownership.items) ||
      !ownership.items.some((item: any) =>
        ["game_minecraft", "product_minecraft"].includes(item.name),
      )
    ) {
      throw new Error(
        "此账号没有可用的 Minecraft Java 版游戏授权，请确认购买或 Game Pass 订阅有效。",
      );
    }
    const profile = await request(
      `${MC}/minecraft/profile`,
      {
        headers: bearer(minecraft.access_token),
        ...(signal
          ? { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }
          : {}),
      },
      "Minecraft 档案",
    );
    const duplicate = this.accounts.find(
      (account) => account.type === "microsoft" && account.uuid === profile.id,
    );
    return {
      id: previous?.id ?? duplicate?.id ?? randomUUID(),
      type: "microsoft",
      name: profile.name,
      uuid: profile.id,
      accessToken: minecraft.access_token,
      refreshToken: token.refresh_token ?? previous?.refreshToken,
      // Keep the app id with the refresh token, encrypted by safeStorage alongside the secret fields.
      clientToken: clientId,
      expiresAt: Date.now() + (Number(minecraft.expires_in) || 86400) * 1000,
      skins: normalizeTextures(profile.skins),
      capes: normalizeTextures(profile.capes),
    };
  }

  async addYggdrasil(input: {
    server: string;
    username: string;
    password: string;
  }): Promise<Account> {
    await this.ready;
    const server = serverUrl(input.server);
    if (!input.username.trim() || !input.password)
      throw new Error("请输入皮肤站账号与密码。");
    const clientToken = randomUUID();
    const auth = await jsonPost(
      `${server}/authserver/authenticate`,
      {
        agent: { name: "Minecraft", version: 1 },
        username: input.username.trim(),
        password: input.password,
        clientToken,
        requestUser: true,
      },
      "皮肤站登录",
    );
    const selected = auth.selectedProfile ?? auth.availableProfiles?.[0];
    if (!selected?.id || !selected?.name || !auth.accessToken)
      throw new Error("皮肤站未返回游戏角色，请先在皮肤站创建角色。");
    const duplicate = this.accounts.find(
      (account) =>
        account.type === "yggdrasil" &&
        account.server === server &&
        account.uuid === selected.id,
    );
    const account: Account = {
      id: duplicate?.id ?? randomUUID(),
      type: "yggdrasil",
      name: selected.name,
      uuid: selected.id,
      accessToken: auth.accessToken,
      clientToken: auth.clientToken ?? clientToken,
      server,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    };
    // Some services require selecting a profile explicitly after the initial authenticate response.
    if (!auth.selectedProfile && auth.availableProfiles?.length) {
      const refreshed = await jsonPost(
        `${server}/authserver/refresh`,
        {
          accessToken: account.accessToken,
          clientToken: account.clientToken,
          selectedProfile: selected,
          requestUser: true,
        },
        "皮肤站角色选择",
      );
      account.accessToken = refreshed.accessToken;
      account.clientToken = refreshed.clientToken ?? account.clientToken;
    }
    await this.save(account);
    return publicAccount(account);
  }

  async getForLaunch(id: string): Promise<Account> {
    const { account, lease } = await this.authorizeForLaunch(id);
    lease.assertCurrent();
    return { ...account };
  }

  private async authorizeForLaunch(id: string): Promise<AuthorizedAccount> {
    const ongoing = this.launchAuth.get(id);
    if (ongoing) {
      const context = await ongoing;
      context.lease.assertCurrent();
      return context;
    }
    const operation = this.resolveForLaunch(id);
    this.launchAuth.set(id, operation);
    try {
      const context = await operation;
      context.lease.assertCurrent();
      return context;
    } finally {
      if (this.launchAuth.get(id) === operation) this.launchAuth.delete(id);
    }
  }

  private async resolveForLaunch(id: string): Promise<AuthorizedAccount> {
    const context = await this.accountContext(id);
    const { account, lease } = context;
    lease.assertCurrent();
    if (account.type === "offline") return context;
    if (!account.accessToken) throw new Error("账号授权已失效，请重新登录。");
    if (account.type === "microsoft") {
      if ((account.expiresAt ?? 0) > Date.now() + 120_000) return context;
      if (!account.refreshToken || !account.clientToken)
        throw new Error("Microsoft 授权已过期，请重新登录。");
      const token = await request(
        `${OAUTH}/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: account.clientToken,
            refresh_token: account.refreshToken,
            scope: SCOPE,
          }).toString(),
        },
        "Microsoft 续期",
      );
      lease.assertCurrent();
      const refreshed = await this.microsoftMinecraft(
        token,
        account.clientToken,
        account,
      );
      const updated = await this.updateAccount(lease, () => refreshed);
      return { account: updated, lease };
    }
    try {
      await jsonPost(
        `${serverUrl(account.server ?? "")}/authserver/validate`,
        { accessToken: account.accessToken, clientToken: account.clientToken },
        "皮肤站验证",
      );
      lease.assertCurrent();
      return context;
    } catch {
      lease.assertCurrent();
      const refreshed = await jsonPost(
        `${serverUrl(account.server ?? "")}/authserver/refresh`,
        {
          accessToken: account.accessToken,
          clientToken: account.clientToken,
          selectedProfile: { id: account.uuid, name: account.name },
          requestUser: true,
        },
        "皮肤站续期",
      );
      if (!refreshed.accessToken)
        throw new Error("皮肤站授权已过期，请重新登录。");
      const updated = await this.updateAccount(lease, (current) => ({
        ...current,
        accessToken: refreshed.accessToken,
        clientToken: refreshed.clientToken ?? current.clientToken,
        expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      }));
      return { account: updated, lease };
    }
  }

  async profile(id: string): Promise<any> {
    return this.profileForAccount(await this.authorizeForLaunch(id));
  }

  private async profileForAccount({
    account,
    lease,
  }: AuthorizedAccount): Promise<any> {
    lease.assertCurrent();
    if (account.type === "microsoft") {
      const profile = await request(
        `${MC}/minecraft/profile`,
        { headers: bearer(account.accessToken!) },
        "Minecraft 档案",
      );
      const updated = await this.updateAccount(lease, (current) => ({
        ...current,
        name: profile.name,
        skins: normalizeTextures(profile.skins),
        capes: normalizeTextures(profile.capes),
      }));
      return {
        id: profile.id,
        name: profile.name,
        skins: updated.skins,
        capes: updated.capes,
        editable: true,
      };
    }
    if (account.type === "yggdrasil") {
      const profile = await request(
        `${serverUrl(account.server!)}/sessionserver/session/minecraft/profile/${encodeURIComponent(account.uuid)}?unsigned=false`,
        {},
        "皮肤站档案",
      );
      lease.assertCurrent();
      const property = profile.properties?.find(
        (item: any) => item.name === "textures",
      );
      let textures: any = {};
      if (property?.value && typeof property.value === "string") {
        try {
          textures =
            JSON.parse(Buffer.from(property.value, "base64").toString("utf8"))
              .textures ?? {};
        } catch {}
      }
      return {
        id: account.uuid,
        name: account.name,
        editable: false,
        skins: normalizeTextureUrl(textures.SKIN?.url)
          ? [
              {
                id: "skin",
                state: "ACTIVE",
                url: normalizeTextureUrl(textures.SKIN.url),
                variant:
                  textures.SKIN.metadata?.model === "slim" ? "SLIM" : "CLASSIC",
              },
            ]
          : [],
        capes: normalizeTextureUrl(textures.CAPE?.url)
          ? [
              {
                id: "cape",
                state: "ACTIVE",
                url: normalizeTextureUrl(textures.CAPE.url),
              },
            ]
          : [],
        manageUrl: account.server,
      };
    }
    return {
      id: account.uuid,
      name: account.name,
      skins: [],
      capes: [],
      editable: false,
    };
  }

  private async officialAccount(id: string): Promise<AuthorizedAccount> {
    const context = await this.authorizeForLaunch(id);
    const { account, lease } = context;
    lease.assertCurrent();
    if (account.type !== "microsoft")
      throw new Error(
        "此操作需要拥有 Java 版的 Microsoft 正版账号；皮肤站账号请前往对应皮肤站管理。",
      );
    return context;
  }

  private async profileAfterChange({
    account,
    lease,
  }: AuthorizedAccount): Promise<any> {
    lease.assertCurrent();
    const current = await this.authorizeForLaunch(account.id);
    lease.assertCurrent();
    return this.profileForAccount(current);
  }

  async uploadSkin(
    id: string,
    filePath: string,
    variant: "classic" | "slim",
  ): Promise<any> {
    const context = await this.officialAccount(id);
    const { account, lease } = context;
    if (!["classic", "slim"].includes(variant))
      throw new Error("皮肤模型须为 classic 或 slim。");
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw new Error("请选择不超过 2 MB 的 PNG 皮肤文件。");
    const buffer = await fs.readFile(filePath);
    validateSkinPng(buffer);
    const form = new FormData();
    form.set("variant", variant);
    form.set(
      "file",
      new Blob([new Uint8Array(buffer)], { type: "image/png" }),
      "skin.png",
    );
    lease.assertCurrent();
    await request(
      `${MC}/minecraft/profile/skins`,
      { method: "POST", headers: bearer(account.accessToken!), body: form },
      "上传正版皮肤",
    );
    return this.profileAfterChange(context);
  }

  async useSkinUrl(
    id: string,
    url: string,
    variant: "classic" | "slim",
  ): Promise<any> {
    const context = await this.officialAccount(id);
    const { account, lease } = context;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("皮肤 URL 无效。");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new Error("皮肤 URL 必须是 HTTPS 地址。");
    if (!["classic", "slim"].includes(variant))
      throw new Error("皮肤模型须为 classic 或 slim。");
    lease.assertCurrent();
    await jsonPost(
      `${MC}/minecraft/profile/skins`,
      { variant, url: parsed.href },
      "更换正版皮肤",
      account.accessToken,
    );
    return this.profileAfterChange(context);
  }

  async resetSkin(id: string): Promise<any> {
    const context = await this.officialAccount(id);
    const { account, lease } = context;
    lease.assertCurrent();
    await request(
      `${MC}/minecraft/profile/skins/active`,
      { method: "DELETE", headers: bearer(account.accessToken!) },
      "重置正版皮肤",
    );
    return this.profileAfterChange(context);
  }

  async activateCape(id: string, capeId: string | null): Promise<any> {
    const context = await this.officialAccount(id);
    const { account, lease } = context;
    lease.assertCurrent();
    if (capeId === null || capeId === "") {
      await request(
        `${MC}/minecraft/profile/capes/active`,
        { method: "DELETE", headers: bearer(account.accessToken!) },
        "取消披风",
      );
    } else {
      const profile = await request(
        `${MC}/minecraft/profile`,
        { headers: bearer(account.accessToken!) },
        "Minecraft 档案",
      );
      lease.assertCurrent();
      if (!profile.capes?.some((cape: any) => cape.id === capeId))
        throw new Error("只能启用此正版账号已拥有的披风。");
      await request(
        `${MC}/minecraft/profile/capes/active`,
        {
          method: "PUT",
          headers: {
            ...bearer(account.accessToken!),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ capeId }),
        },
        "启用披风",
      );
    }
    return this.profileAfterChange(context);
  }
}
