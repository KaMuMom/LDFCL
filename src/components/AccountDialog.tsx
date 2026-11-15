import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Grid2X2,
  LoaderCircle,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LauncherAPI, State } from "@ldfcl/contracts/types";
import { errorMessage } from "../ui/format";
import Modal from "../ui/Modal";
function MicrosoftDeviceStatus({
  auth,
  call,
  onError,
}: {
  auth: any;
  call: LauncherAPI["call"];
  onError: (message: string) => void;
}) {
  const [seconds, setSeconds] = useState(auth.expiresIn ?? 0);
  const [copied, setCopied] = useState(auth.codeCopied === true);
  useEffect(() => {
    setCopied(auth.codeCopied === true);
  }, [auth.userCode, auth.codeCopied]);
  useEffect(() => {
    const expiresAt = Date.now() + (auth.expiresIn ?? 0) * 1000;
    const update = () =>
      setSeconds(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [auth.userCode, auth.expiresIn]);
  const waiting = auth.status === "waiting";
  return (
    <div className="device-auth-status" role="status" aria-live="polite">
      <div className="device-auth-heading">
        <LoaderCircle className="spin" size={20} />
        <strong>{waiting ? "等待微软授权" : "正在获取 Minecraft 档案"}</strong>
      </div>
      {waiting && (
        <>
          <p>{auth.message || "在已打开的微软页面输入以下授权码："}</p>
          <code className="device-code-value" aria-label="微软授权码">
            {auth.userCode}
          </code>
          <p className="device-code-copy-status">
            {copied
              ? auth.codeCopied
                ? "授权码已自动复制，可在微软页面直接粘贴。"
                : "授权码已复制，可在微软页面直接粘贴。"
              : auth.copyMessage ||
                (auth.codeCopied === false
                  ? "未能自动复制授权码，请使用“复制授权码”按钮或手动输入。"
                  : "正在准备复制授权码…")}
          </p>
          <div className="device-auth-actions">
            <button
              className="btn subtle"
              aria-label="复制授权码"
              onClick={() =>
                void navigator.clipboard
                  .writeText(auth.userCode)
                  .then(() => setCopied(true))
                  .catch(() => onError("无法复制，请手动输入上方授权码。"))
              }
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "已复制" : "复制授权码"}
            </button>
            <button
              className="btn subtle"
              onClick={() =>
                void call("external", { url: auth.verificationUri }).catch(
                  (e) => onError(errorMessage(e)),
                )
              }
            >
              打开微软授权页面 <ExternalLink size={15} />
            </button>
          </div>
          <small className="device-auth-expiry" aria-live="off">
            剩余 {Math.floor(seconds / 60)}:
            {String(seconds % 60).padStart(2, "0")}
            ，完成后将自动登录
          </small>
        </>
      )}
      {!waiting && <p>{auth.message}</p>}
      <button
        className="text-button"
        onClick={() =>
          void call("account:cancel").catch((e) => onError(errorMessage(e)))
        }
      >
        取消本次登录
      </button>
    </div>
  );
}
export default function AccountDialog({
  state,
  call,
  auth,
  refresh,
  notify,
  close,
}: {
  state: State;
  call: LauncherAPI["call"];
  auth: any;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  close: () => void;
}) {
  const [type, setType] = useState("microsoft"),
    [name, setName] = useState(""),
    [server, setServer] = useState(""),
    [password, setPassword] = useState(""),
    [clientId, setClientId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef(0);
  const devicePending =
    type === "microsoft" &&
    auth?.flow === "device" &&
    ["waiting", "authenticating"].includes(auth.status);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const displayError =
    error ||
    (type === "microsoft" &&
    !busy &&
    auth?.flow === "device" &&
    ["error", "expired"].includes(auth.status)
      ? auth.message
      : "");
  const cancelPending = async () => {
    if (type === "microsoft") await call("account:cancel");
  };
  const closeAccount = () => {
    if (busy && type !== "microsoft") return;
    attempt.current++;
    void cancelPending()
      .then(close)
      .catch((e) => setError(errorMessage(e)));
  };
  const add = async () => {
    const run = ++attempt.current;
    setBusy(true);
    setError("");
    try {
      if (type === "offline") {
        await call("account:offline", { name });
        await refresh();
        close();
        notify("离线账号已添加");
      } else if (type === "yggdrasil") {
        await call("account:yggdrasil", { server, username: name, password });
        setPassword("");
        await refresh();
        close();
        notify("皮肤站账号已添加");
      } else {
        if (clientId.trim()) {
          await call("settings", { microsoftClientId: clientId.trim() });
          if (run === attempt.current) setClientId("");
          await refresh();
        }
        if (run !== attempt.current) return;
        await call("account:microsoft");
      }
    } catch (e) {
      if (run === attempt.current) setError(errorMessage(e));
    } finally {
      if (run === attempt.current) setBusy(false);
    }
  };
  return (
    <Modal
      title="你的冒险身份"
      subtitle="支持 Microsoft 正版、离线和 Yggdrasil 皮肤站。"
      close={closeAccount}
    >
      <div className="segmented account-tabs">
        {[
          ["microsoft", "正版登录"],
          ["offline", "离线账号"],
          ["yggdrasil", "其他皮肤站"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={type === id ? "selected" : ""}
            disabled={busy}
            onClick={() => {
              if (id === type || busy) return;
              setBusy(true);
              void cancelPending()
                .then(() => {
                  setType(id);
                  setError("");
                })
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {type === "microsoft" ? (
        <>
          {!devicePending && (
            <div className="microsoft-login-intro">
              <ShieldCheck size={30} />
              <div>
                <strong>使用 Microsoft 账号登录</strong>
                <p>
                  通过微软设备代码完成正版授权。在系统浏览器的 Microsoft
                  页面输入代码，LDFCL 不会接收您的微软密码。
                </p>
              </div>
            </div>
          )}
          {!devicePending && (
            <details
              className="auth-config"
              open={
                state.settings.microsoftClientIdStorageStatus !== "ready" &&
                !busy &&
                !["waiting", "authenticating"].includes(auth?.status)
              }
            >
              <summary>应用授权配置</summary>
              <div className="field">
                <label htmlFor="microsoft-client-id">
                  Microsoft 应用 Client ID
                </label>
                <input
                  id="microsoft-client-id"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={clientId}
                  disabled={
                    busy || ["waiting", "authenticating"].includes(auth?.status)
                  }
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    state.settings.microsoftClientIdStorageStatus === "ready"
                      ? "已加密保存，留空继续使用"
                      : "具有 Minecraft API 权限的公用客户端 ID"
                  }
                />
              </div>
              <p>
                {state.settings.microsoftClientIdStorageStatus === "ready"
                  ? "Client ID 已加密保存。留空继续使用，输入新值可替换。"
                  : state.settings.microsoftClientIdStorageStatus ===
                      "unavailable"
                    ? "系统加密存储不可用，请恢复系统加密功能后重新配置。"
                    : state.settings.microsoftClientIdStorageStatus ===
                        "unreadable"
                      ? "保存的授权配置无法解密，请重新输入 Client ID。"
                      : state.settings.microsoftClientIdStorageStatus ===
                          "migration-pending"
                        ? "旧授权配置尚未完成加密迁移，请恢复系统加密功能后重新配置。"
                        : "尚未配置 Client ID，保存时将使用系统加密存储。"}
              </p>
              <p>
                使用自有且获准访问 Minecraft API 的应用，并启用公用客户端流程。
                设备代码登录无需配置本机回调地址。
              </p>
            </details>
          )}
          <p className="auth-tls-note">
            <ShieldCheck size={15} />
            正版登录使用 HTTPS 证书验证，证书异常时停止登录。
          </p>
          {auth?.flow === "device" &&
            ["waiting", "authenticating"].includes(auth.status) && (
              <MicrosoftDeviceStatus
                auth={auth}
                call={call}
                onError={setError}
              />
            )}
        </>
      ) : (
        <>
          {type === "yggdrasil" && (
            <div className="field">
              <label>认证服务器地址</label>
              <input
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://皮肤站/api/yggdrasil"
              />
            </div>
          )}
          <div className="field">
            <label>
              {type === "offline"
                ? "玩家名称（3–16 个英文字母、数字或下划线）"
                : "用户名 / 邮箱"}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === "offline" ? "Steve" : "你的皮肤站用户名"}
            />
          </div>
          {type === "yggdrasil" && (
            <div className="field">
              <label>密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                placeholder="仅用于本次登录，不保存密码"
              />
            </div>
          )}
          {type === "offline" && (
            <div className="notice">
              <Globe size={18} />
              <span>离线身份适用于本地游戏及允许离线登录的服务器。</span>
            </div>
          )}
        </>
      )}
      {displayError && (
        <div className="error-box" role="alert">
          {displayError}
        </div>
      )}
      {!devicePending && (
        <button
          className="btn primary full"
          disabled={
            busy ||
            (type === "microsoft" &&
              ["waiting", "authenticating"].includes(auth?.status))
          }
          onClick={() => void add()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : type === "microsoft" ? (
            <Grid2X2 size={17} />
          ) : (
            <Plus size={17} />
          )}{" "}
          {type === "microsoft"
            ? busy
              ? "正在获取授权码…"
              : "开始微软登录"
            : "添加账号"}
        </button>
      )}
    </Modal>
  );
}
