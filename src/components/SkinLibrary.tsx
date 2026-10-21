import { useEffect, useRef, useState } from "react";
import {
  BookmarkPlus,
  Check,
  Download,
  ImagePlus,
  Pencil,
  RefreshCw,
  Shirt,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Account, SkinLibraryEntry } from "../../shared/types";
import { GlassBackdrop, GlassSurface } from "../ui/Glass";
import "./skin-library.css";

export type SkinLibraryDraft = {
  name: string;
  variant: "classic" | "slim";
  dataUrl: string;
};
type Props = {
  call: (method: string, payload?: any) => Promise<any>;
  notify: (message: string) => void;
  account?: Account;
  editable: boolean;
  disabled: boolean;
  variant: "classic" | "slim";
  selectedId?: string;
  draft: SkinLibraryDraft | null;
  onDraftClose: () => void;
  onSaveCurrent: () => void;
  onSelect: (entry: SkinLibraryEntry) => void;
  onApplied: (entry: SkinLibraryEntry, profile: any) => void;
  onRemoved: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
};
const message = (error: any) =>
  String(error?.message || "皮肤库操作失败").replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );

/** Lightweight front-view thumbnails; the selected card uses the main 3D viewer. */
function SkinThumbnail({ entry }: { entry: SkinLibraryEntry }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let current = true;
    const image = new Image();
    image.onload = () => {
      if (!current || !canvas.current) return;
      const context = canvas.current.getContext("2d")!;
      context.clearRect(0, 0, 80, 92);
      context.imageSmoothingEnabled = false;
      const part = (
        sx: number,
        sy: number,
        width: number,
        height: number,
        x: number,
        y: number,
      ) =>
        context.drawImage(
          image,
          sx,
          sy,
          width,
          height,
          x,
          y,
          width * 2,
          height * 2,
        );
      const slim = entry.variant === "slim",
        arm = slim ? 3 : 4;
      part(8, 8, 8, 8, 32, 10);
      part(20, 20, 8, 12, 32, 26);
      part(44, 20, arm, 12, 32 - arm * 2, 26);
      if (image.height === 64) part(36, 52, arm, 12, 48, 26);
      else part(44, 20, arm, 12, 48, 26);
      part(4, 20, 4, 12, 32, 50);
      part(
        image.height === 64 ? 20 : 4,
        image.height === 64 ? 52 : 20,
        4,
        12,
        40,
        50,
      );
      part(40, 8, 8, 8, 32, 10);
      if (image.height === 64) {
        part(20, 36, 8, 12, 32, 26);
        part(44, 36, arm, 12, 32 - arm * 2, 26);
        part(52, 52, arm, 12, 48, 26);
        part(4, 36, 4, 12, 32, 50);
        part(4, 52, 4, 12, 40, 50);
      }
    };
    image.src = entry.dataUrl;
    return () => {
      current = false;
      image.onload = null;
    };
  }, [entry.dataUrl, entry.variant]);
  return <canvas ref={canvas} width={80} height={92} aria-hidden="true" />;
}

type EditDialog = { kind: "rename" | "delete"; entry: SkinLibraryEntry };
function LibraryDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="glass-surface skin-library-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <GlassBackdrop />
      <header>
        <h3>{title}</h3>
        <button
          className="icon-btn"
          aria-label="关闭皮肤库窗口"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export default function SkinLibrary({
  call,
  notify,
  account,
  editable,
  disabled,
  variant,
  selectedId,
  draft,
  onDraftClose,
  onSaveCurrent,
  onSelect,
  onApplied,
  onRemoved,
  onBusyChange,
}: Props) {
  const [entries, setEntries] = useState<SkinLibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [edit, setEdit] = useState<EditDialog | null>(null);
  const [name, setName] = useState("");
  const [dialogError, setDialogError] = useState("");
  const mounted = useRef(false);
  const operation = useRef(false);
  const currentAccountId = useRef(account?.id);
  currentAccountId.current = account?.id;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange(false);
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    call("skin-library:list")
      .then((result) => {
        if (current) setEntries(result);
      })
      .catch((e) => {
        if (current) setError(message(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [call, retry]);
  useEffect(() => {
    setName(draft?.name || (edit?.kind === "rename" ? edit.entry.name : ""));
    setDialogError("");
  }, [draft, edit]);
  const replace = (entry: SkinLibraryEntry) =>
    setEntries((previous) => [
      entry,
      ...previous.filter((item) => item.id !== entry.id),
    ]);
  const run = async (task: () => Promise<void>, inDialog = false) => {
    if (operation.current || disabled) return;
    operation.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setDialogError("");
    try {
      await task();
    } catch (e) {
      if (mounted.current) {
        if (inDialog) setDialogError(message(e));
        else setError(message(e));
      }
      notify(message(e));
    } finally {
      operation.current = false;
      onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  };
  const closeDialog = () => {
    if (!operation.current) {
      setEdit(null);
      onDraftClose();
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (draft) {
        const entry = await call("skin-library:save", { ...draft, name });
        if (mounted.current) {
          replace(entry);
          onDraftClose();
        }
        notify("已保存到本地皮肤库。");
      } else if (edit?.kind === "rename") {
        const entry = await call("skin-library:rename", {
          id: edit.entry.id,
          name,
        });
        if (mounted.current) {
          replace(entry);
          if (selectedId === entry.id) onSelect(entry);
          setEdit(null);
        }
        notify("皮肤名称已更新。");
      } else if (edit?.kind === "delete") {
        await call("skin-library:remove", { id: edit.entry.id });
        if (mounted.current) {
          setEntries((previous) =>
            previous.filter((entry) => entry.id !== edit.entry.id),
          );
          onRemoved(edit.entry.id);
          setEdit(null);
        }
        notify("已从本地皮肤库删除。");
      }
    }, true);
  };
  const locked = busy || disabled;
  const canApply = account?.type === "microsoft" && editable;
  return (
    <GlassSurface as="section" className="skin-library" aria-label="本地皮肤库">
      <header className="skin-library-heading">
        <div>
          <h3>
            <Shirt size={18} /> 我的皮肤库{" "}
            <span className="badge">{entries.length}</span>
          </h3>
          <p>收藏你的搭配，随时切换预览。皮肤保存在本机。</p>
        </div>
        <div className="skin-library-toolbar">
          <button
            className="btn subtle"
            disabled={locked || loading}
            aria-label="刷新皮肤库"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="btn subtle"
            disabled={locked || loading}
            onClick={() =>
              void run(async () => {
                const entry = await call("skin-library:import", { variant });
                if (entry) {
                  if (mounted.current) {
                    replace(entry);
                    onSelect(entry);
                  }
                  notify("本地皮肤已加入皮肤库，可在左侧预览。");
                }
              })
            }
          >
            <ImagePlus size={15} /> 添加本地皮肤
          </button>
          <button
            className="btn primary"
            disabled={locked || loading}
            onClick={onSaveCurrent}
          >
            <BookmarkPlus size={15} /> 收藏当前预览
          </button>
        </div>
      </header>
      {error && (
        <div className="skin-library-error" role="alert">
          {error}
          <button
            className="text-button"
            disabled={locked}
            onClick={() => setRetry((value) => value + 1)}
          >
            重新加载
          </button>
        </div>
      )}
      {loading ? (
        <div className="skin-library-empty">
          <span className="spinner" />
          正在读取皮肤库…
        </div>
      ) : entries.length ? (
        <div className="skin-library-grid">
          {entries.map((entry) => (
            <article
              className={`skin-library-card ${selectedId === entry.id ? "selected" : ""}`}
              key={entry.id}
            >
              <button
                className="skin-library-preview"
                aria-label={`预览皮肤 ${entry.name}`}
                aria-pressed={selectedId === entry.id}
                onClick={() => onSelect(entry)}
                disabled={locked}
              >
                <SkinThumbnail entry={entry} />
                {selectedId === entry.id && (
                  <span className="skin-library-selected">
                    <Check size={12} /> 正在预览
                  </span>
                )}
              </button>
              <div className="skin-library-card-body">
                <h4 title={entry.name}>{entry.name}</h4>
                <p>
                  {entry.variant === "slim" ? "纤细 · 3 像素" : "经典 · 4 像素"}
                </p>
                <div className="skin-library-card-tools">
                  <button
                    className="icon-btn"
                    aria-label={`重命名皮肤 ${entry.name}`}
                    title="重命名"
                    disabled={locked}
                    onClick={() => setEdit({ kind: "rename", entry })}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`导出皮肤 ${entry.name}`}
                    title="导出 PNG"
                    disabled={locked}
                    onClick={() =>
                      void run(async () => {
                        const result = await call("skin-library:export", {
                          id: entry.id,
                        });
                        if (result) notify("皮肤 PNG 已导出。");
                      })
                    }
                  >
                    <Download size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`删除皮肤 ${entry.name}`}
                    title="从本地皮肤库删除"
                    disabled={locked}
                    onClick={() => setEdit({ kind: "delete", entry })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <button
                  className="btn subtle skin-library-apply"
                  disabled={locked || !canApply}
                  title={
                    canApply
                      ? `将此皮肤上传至 ${account.name}`
                      : "选择已登录的正版账号后可应用"
                  }
                  onClick={() =>
                    void run(async () => {
                      const profile = await call("skin-library:apply", {
                        id: entry.id,
                        accountId: account!.id,
                      });
                      if (
                        mounted.current &&
                        currentAccountId.current === account!.id
                      )
                        onApplied(entry, profile);
                      notify(
                        `已将「${entry.name}」应用至正版账号 ${account!.name}。`,
                      );
                    })
                  }
                >
                  <Upload size={13} /> 应用至正版账号
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : !error ? (
        <div className="skin-library-empty">
          <Shirt size={32} />
          <strong>你的皮肤收藏，从这里开始</strong>
          <span>添加本地 PNG，或把当前预览、编辑后的皮肤保存进来。</span>
        </div>
      ) : null}
      <p className="skin-library-footnote">
        {canApply
          ? `应用目标：${account.name}。点击卡片只切换预览；点击“应用至正版账号”才上传。`
          : "无需登录即可收藏、编辑和导出。登录正版账号后，可上传已收藏的皮肤。"}
      </p>
      {(draft || edit) && (
        <LibraryDialog
          title={
            draft
              ? "保存到皮肤库"
              : edit!.kind === "rename"
                ? "重命名皮肤"
                : "删除收藏皮肤"
          }
          onClose={closeDialog}
        >
          <form onSubmit={submit}>
            {edit?.kind === "delete" && !draft ? (
              <p className="skin-library-delete-copy">
                从本地皮肤库删除「{edit.entry.name}
                」？已应用到账号的皮肤不受影响。
              </p>
            ) : (
              <>
                <label htmlFor="skin-library-name">皮肤名称</label>
                <input
                  id="skin-library-name"
                  className="field"
                  value={name}
                  autoFocus
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="为这件皮肤起个名字"
                />
                <p className="skin-library-dialog-hint">
                  {(draft?.variant || edit?.entry.variant) === "slim"
                    ? "纤细模型 · 3 像素手臂"
                    : "经典模型 · 4 像素手臂"}{" "}
                  · 仅保存在本地
                </p>
              </>
            )}
            {dialogError && (
              <p className="skin-library-error" role="alert">
                {dialogError}
              </p>
            )}
            <footer>
              <button
                className="btn subtle"
                type="button"
                disabled={busy}
                onClick={closeDialog}
              >
                取消
              </button>
              <button
                className={`btn ${edit?.kind === "delete" && !draft ? "danger" : "primary"}`}
                type="submit"
                disabled={
                  locked ||
                  (!(edit?.kind === "delete" && !draft) && !name.trim())
                }
              >
                {busy
                  ? "正在保存…"
                  : edit?.kind === "delete" && !draft
                    ? "删除"
                    : "保存"}
              </button>
            </footer>
          </form>
        </LibraryDialog>
      )}
    </GlassSurface>
  );
}
