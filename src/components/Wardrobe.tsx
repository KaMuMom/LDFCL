import { useEffect, useMemo, useRef, useState } from "react";
import { SkinViewer, WalkingAnimation } from "skinview3d";
import { loadSkinToCanvas } from "skinview-utils";
import {
  BookmarkPlus,
  Check,
  ChevronRight,
  Download,
  Eraser,
  ExternalLink,
  ImagePlus,
  LoaderCircle,
  Palette,
  Pause,
  Play,
  RotateCcw,
  Shirt,
  Sparkles,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Account, SkinLibraryEntry } from "../../shared/types";
import {
  DEFAULT_SKIN_NAME,
  defaultSkinTexture,
} from "../../shared/default-skin";
import SkinLibrary, { type SkinLibraryDraft } from "./SkinLibrary";
import { GlassBackdrop, GlassSurface } from "../ui/Glass";
import "./wardrobe.css";

type Props = {
  accounts: Account[];
  selectedAccountId?: string;
  call: (method: string, payload?: any) => Promise<any>;
  notify: (message: string) => void;
};
type Texture = { url: string; name: string; libraryId?: string };
type Profile = {
  skins: any[];
  capes: any[];
  editable: boolean;
  name?: string;
  manageUrl?: string;
};

function skinDataUrl(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (
      source !== defaultSkinTexture() &&
      !/^(data:image\/png;base64,|https?:\/\/)/.test(source)
    ) {
      reject(new Error("请先导入有效的皮肤 PNG。"));
      return;
    }
    const image = new Image();
    image.crossOrigin = "anonymous";
    const timeout = window.setTimeout(() => {
      image.onload = image.onerror = null;
      reject(new Error("读取皮肤超时，请导入本地 PNG 后收藏。"));
    }, 15000);
    image.onload = () => {
      window.clearTimeout(timeout);
      try {
        if (image.width !== 64 || ![32, 64].includes(image.height))
          throw new Error("皮肤库支持 64×64 或 64×32 像素的 PNG。");
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext("2d")!.drawImage(image, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch (error: any) {
        reject(
          new Error(
            error.name === "SecurityError"
              ? "此皮肤站限制读取图片，请导入本地 PNG 后收藏。"
              : error.message,
          ),
        );
      }
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("无法读取当前皮肤，请导入本地 PNG 后收藏。"));
    };
    image.src = source;
  });
}

export default function Wardrobe({
  accounts,
  selectedAccountId,
  call,
  notify,
}: Props) {
  const [accountId, setAccountId] = useState(
    selectedAccountId ?? accounts[0]?.id ?? "",
  );
  const [profile, setProfile] = useState<Profile>({
    skins: [],
    capes: [],
    editable: false,
  });
  const [loading, setLoading] = useState(false);
  const [actionBusy, setBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const busy = actionBusy || libraryBusy;
  const [variant, setVariant] = useState<"classic" | "slim">("classic");
  const [localSkin, setLocalSkin] = useState<Texture | null>(null);
  const [localCape, setLocalCape] = useState<Texture | null>(null);
  const [rotating, setRotating] = useState(true);
  const [viewerError, setViewerError] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [libraryDraft, setLibraryDraft] = useState<SkinLibraryDraft | null>(
    null,
  );
  const [brushColor, setBrushColor] = useState("#5b8d7c");
  const [brushSize, setBrushSize] = useState(1);
  const [eraser, setEraser] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const previewCanvas = useRef<HTMLCanvasElement>(null);
  const editCanvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<SkinViewer | null>(null);
  const dragging = useRef(false);
  const history = useRef<ImageData[]>([]);
  const editorReady = useRef(false);
  const defaultSkin = useMemo(defaultSkinTexture, []);
  const account = accounts.find((item) => item.id === accountId);
  const activeSkin =
    profile.skins.find((item) => item.state === "ACTIVE") ?? profile.skins[0];
  const activeCape = profile.capes.find((item) => item.state === "ACTIVE");
  const skinSource: string = localSkin?.url ?? activeSkin?.url ?? defaultSkin;
  const capeSource: string | undefined = localCape?.url ?? activeCape?.url;

  useEffect(() => {
    if (selectedAccountId) setAccountId(selectedAccountId);
  }, [selectedAccountId]);
  useEffect(() => {
    if (accountId && !accounts.some((item) => item.id === accountId))
      setAccountId(accounts[0]?.id ?? "");
  }, [accounts, accountId]);

  useEffect(() => {
    let cancelled = false;
    setLocalSkin(null);
    setLocalCape(null);
    if (!accountId) {
      setProfile({ skins: [], capes: [], editable: false });
      setVariant("classic");
      setLoading(false);
      return;
    }
    setLoading(true);
    setProfile({ skins: [], capes: [], editable: false });
    call("skin:profile", { id: accountId })
      .then((result) => {
        if (cancelled) return;
        setProfile({
          ...result,
          skins: result.skins ?? [],
          capes: result.capes ?? [],
        });
        const skin =
          result.skins?.find((item: any) => item.state === "ACTIVE") ??
          result.skins?.[0];
        setVariant(
          String(skin?.variant).toUpperCase() === "SLIM" ? "slim" : "classic",
        );
      })
      .catch((error) => {
        if (!cancelled) notify(error.message ?? "角色档案加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, call, notify]);

  useEffect(() => {
    if (!previewCanvas.current || !stage.current) return;
    let instance: SkinViewer;
    try {
      instance = new SkinViewer({
        canvas: previewCanvas.current,
        width: stage.current.clientWidth,
        height: 520,
        pixelRatio: Math.min(window.devicePixelRatio, 2),
        zoom: 0.74,
        fov: 42,
        enableControls: true,
      });
      instance.autoRotate = true;
      instance.autoRotateSpeed = 0.35;
      const animation = new WalkingAnimation();
      animation.speed = 0.32;
      instance.animation = animation;
      instance.playerObject.rotation.y = -0.35;
      instance.controls.enablePan = false;
      instance.controls.minDistance = 38;
      instance.controls.maxDistance = 110;
      viewer.current = instance;
    } catch {
      setViewerError(true);
      return;
    }
    const resize = new ResizeObserver(() => {
      if (stage.current && !instance.disposed)
        instance.setSize(
          stage.current.clientWidth,
          Math.max(500, stage.current.clientHeight),
        );
    });
    resize.observe(stage.current);
    return () => {
      resize.disconnect();
      instance.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = viewer.current;
    if (!instance) return;
    let cancelled = false;
    Promise.resolve(
      instance.loadSkin(skinSource, {
        model: variant === "slim" ? "slim" : "default",
      }),
    ).catch(() => {
      if (!cancelled)
        notify("皮肤纹理加载失败。可导入本地 PNG 继续预览与编辑。");
    });
    if (capeSource)
      Promise.resolve(instance.loadCape(capeSource)).catch(() => {
        if (!cancelled) notify("披风纹理加载失败，请尝试本地 PNG。");
      });
    else instance.loadCape(null);
    return () => {
      cancelled = true;
    };
  }, [skinSource, capeSource, variant, notify]);

  useEffect(() => {
    if (viewer.current) viewer.current.autoRotate = rotating;
  }, [rotating]);

  useEffect(() => {
    if (!editorOpen || !editCanvas.current) return;
    editorReady.current = false;
    history.current = [];
    const canvas = editCanvas.current;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.clearRect(0, 0, 64, 64);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (![32, 64].includes(image.height) || image.width !== 64) {
        notify("像素编辑器支持 64×64 或 64×32 皮肤 PNG。");
        setEditorOpen(false);
        return;
      }
      try {
        loadSkinToCanvas(canvas, image);
        context.getImageData(0, 0, 64, 64);
        editorReady.current = true;
      } catch {
        notify("此皮肤站限制跨域编辑。请先导入本地 PNG，再打开编辑器。");
        setEditorOpen(false);
      }
    };
    image.onerror = () => {
      notify("无法载入纹理进行编辑。请先导入本地 PNG。");
      setEditorOpen(false);
    };
    image.src = skinSource;
    return () => {
      image.onload = null;
      image.onerror = null;
      dragging.current = false;
    };
  }, [editorOpen, skinSource, notify]);

  const action = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } catch (error: any) {
      notify(error.message ?? "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const chooseTexture = (kind: "skin" | "cape") =>
    action(async () => {
      const result = await call("skin:preview");
      if (result) {
        if (kind === "skin") setLocalSkin(result);
        else setLocalCape(result);
        notify("已载入本地纹理，仅用于预览。");
      }
    });
  const upload = () =>
    action(async () => {
      const result = await call("skin:upload", { id: accountId, variant });
      if (result) {
        setProfile(result);
        setLocalSkin(null);
        notify("正版皮肤已更新。");
      }
    });
  const selectCape = (capeId: string | null) =>
    action(async () => {
      const result = await call("skin:cape", { id: accountId, capeId });
      setProfile(result);
      setLocalCape(null);
      notify(capeId ? "披风已启用。" : "已收起披风。");
    });
  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current || !editorReady.current) return;
    const canvas = editCanvas.current!;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * 64),
      y = Math.floor(((event.clientY - rect.top) / rect.height) * 64);
    if (x < 0 || y < 0 || x >= 64 || y >= 64) return;
    const context = canvas.getContext("2d")!;
    if (eraser) context.clearRect(x, y, brushSize, brushSize);
    else {
      context.fillStyle = brushColor;
      context.fillRect(x, y, brushSize, brushSize);
    }
  };
  const editedData = () => {
    if (!editorReady.current || !editCanvas.current)
      throw new Error("纹理尚未加载完成。");
    return editCanvas.current.toDataURL("image/png");
  };
  const selectLibrarySkin = (entry: SkinLibraryEntry) => {
    setLocalSkin({ url: entry.dataUrl, name: entry.name, libraryId: entry.id });
    setVariant(entry.variant);
  };
  const saveCurrentToLibrary = () =>
    action(async () => {
      const dataUrl = await skinDataUrl(skinSource);
      setLibraryDraft({
        dataUrl,
        variant,
        name:
          localSkin?.name?.replace(/\.png$/i, "") ||
          (activeSkin
            ? `${account?.name || "我的"} 的皮肤`
            : DEFAULT_SKIN_NAME),
      });
    });

  return (
    <div className="wardrobe">
      <div className="wardrobe-layout">
        <div className="glass-surface wardrobe-stage" ref={stage}>
          <GlassBackdrop />
          <div className="wardrobe-stage-top">
            <span className="badge">
              <Sparkles size={12} /> 角色试衣间
            </span>
            <span className="muted wardrobe-preview-status">
              {localSkin
                ? localSkin.libraryId
                  ? "皮肤库预览"
                  : "本地纹理预览"
                : activeSkin
                  ? "当前账号皮肤"
                  : "本地示例纹理"}
            </span>
          </div>
          <canvas
            ref={previewCanvas}
            aria-label="可拖拽旋转的 Minecraft 角色三维预览"
          />
          {viewerError && (
            <div className="empty wardrobe-viewer-error">
              当前显卡无法创建 3D 预览，皮肤管理功能仍可使用。
            </div>
          )}
          <div className="wardrobe-stage-hint">
            拖动旋转 · 滚轮缩放 · 展示你的每一面
          </div>
          <div className="wardrobe-stage-bottom">
            <span className="wardrobe-preview-name">
              {account?.name ?? DEFAULT_SKIN_NAME}
            </span>
            <div className="wardrobe-tools">
              <button
                aria-label={rotating ? "暂停自动旋转" : "开启自动旋转"}
                title={rotating ? "暂停自动旋转" : "开启自动旋转"}
                aria-pressed={rotating}
                onClick={() => setRotating(!rotating)}
              >
                {rotating ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button
                aria-label="缩小角色"
                title="缩小"
                onClick={() => {
                  if (viewer.current)
                    viewer.current.zoom = Math.max(
                      0.35,
                      viewer.current.zoom - 0.1,
                    );
                }}
              >
                <ZoomOut size={16} />
              </button>
              <button
                aria-label="放大角色"
                title="放大"
                onClick={() => {
                  if (viewer.current)
                    viewer.current.zoom = Math.min(
                      1.15,
                      viewer.current.zoom + 0.1,
                    );
                }}
              >
                <ZoomIn size={16} />
              </button>
              <button
                aria-label="重置观察角度"
                title="重置观察角度"
                onClick={() => {
                  if (viewer.current) {
                    viewer.current.resetCameraPose();
                    viewer.current.zoom = 0.74;
                  }
                }}
              >
                <RotateCcw size={15} />
              </button>
            </div>
          </div>
        </div>
        <div className="wardrobe-controls">
          <GlassSurface as="section" className="wardrobe-card">
            <h3>
              <Shirt size={17} /> 角色与皮肤
            </h3>
            <label className="label" htmlFor="wardrobe-account">
              正在管理的账号
            </label>
            <select
              className="field wardrobe-account-field"
              id="wardrobe-account"
              value={accountId}
              disabled={busy}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {!accounts.length && (
                <option value="">本地预览 · 添加账号后同步</option>
              )}
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ·{" "}
                  {item.type === "microsoft"
                    ? "正版"
                    : item.type === "yggdrasil"
                      ? "皮肤站"
                      : "离线"}
                </option>
              ))}
            </select>
            {loading && (
              <p className="wardrobe-loading">
                <LoaderCircle size={14} className="wardrobe-spin" />
                正在加载角色档案
              </p>
            )}
            <div className="wardrobe-texture">
              <img src={skinSource} alt="当前皮肤展开纹理" />
              <div>
                <strong>
                  {localSkin?.name ??
                    (activeSkin
                      ? `${account?.name ?? ""} 的皮肤`
                      : DEFAULT_SKIN_NAME)}
                </strong>
                <small>
                  {localSkin
                    ? localSkin.libraryId
                      ? "本地收藏 · 点击应用时上传"
                      : "本地预览 · 尚未上传"
                    : activeSkin
                      ? "已与账号同步"
                      : "示例皮肤 · 可导入、编辑"}
                </small>
              </div>
            </div>
            <label className="label">手臂模型</label>
            <div className="wardrobe-models">
              <button
                className={variant === "classic" ? "active" : ""}
                disabled={busy}
                onClick={() => setVariant("classic")}
              >
                经典 · 4 像素
              </button>
              <button
                className={variant === "slim" ? "active" : ""}
                disabled={busy}
                onClick={() => setVariant("slim")}
              >
                纤细 · 3 像素
              </button>
            </div>
            <div className="wardrobe-actions">
              <button
                className="btn subtle"
                disabled={busy}
                onClick={() => void chooseTexture("skin")}
              >
                <ImagePlus size={15} /> 导入预览
              </button>
              <button
                className="btn subtle"
                disabled={busy}
                onClick={() => setEditorOpen(true)}
              >
                <Palette size={15} /> 图形编辑
              </button>
            </div>
            <button
              className="btn subtle wardrobe-library-save"
              disabled={busy || loading}
              onClick={() => void saveCurrentToLibrary()}
            >
              <BookmarkPlus size={15} /> 保存当前皮肤到库
            </button>
            {profile.editable && (
              <>
                <button
                  className="btn primary wardrobe-full-action"
                  disabled={busy || loading}
                  onClick={() => void upload()}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="wardrobe-spin" />
                  ) : (
                    <Upload size={15} />
                  )}{" "}
                  上传皮肤至正版账号
                </button>
                <button
                  className="btn subtle wardrobe-reset"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      setProfile(await call("skin:reset", { id: accountId }));
                      setLocalSkin(null);
                      notify("已恢复默认正版皮肤。");
                    })
                  }
                >
                  <RotateCcw size={13} /> 恢复默认皮肤
                </button>
              </>
            )}
            {profile.manageUrl && (
              <button
                className="btn subtle wardrobe-full-action"
                onClick={() =>
                  void action(async () => {
                    await call("external", { url: profile.manageUrl });
                  })
                }
              >
                <ExternalLink size={14} /> 前往皮肤站管理{" "}
                <ChevronRight size={13} />
              </button>
            )}
            {!profile.editable && (
              <p className="wardrobe-note">
                本地预览支持导入与像素编辑。使用正版账号登录后，可将编辑后的皮肤同步至游戏。
              </p>
            )}
          </GlassSurface>
          <GlassSurface as="section" className="wardrobe-card">
            <div className="wardrobe-row">
              <h3>
                <Sparkles size={16} /> 披风收藏
              </h3>
              <span className="badge">{profile.capes.length} 件</span>
            </div>
            {profile.capes.length > 0 ? (
              <div className="wardrobe-capelist">
                <button
                  className={`wardrobe-cape ${!activeCape && !localCape ? "active" : ""}`}
                  disabled={busy || !profile.editable}
                  onClick={() => void selectCape(null)}
                >
                  <Shirt size={24} strokeWidth={1} />
                  <span>不佩戴</span>
                </button>
                {profile.capes.map((cape) => (
                  <button
                    key={cape.id}
                    className={`wardrobe-cape ${cape.state === "ACTIVE" && !localCape ? "active" : ""}`}
                    disabled={busy || !profile.editable}
                    onClick={() => void selectCape(cape.id)}
                    title={cape.alias ?? cape.id}
                  >
                    {cape.state === "ACTIVE" && !localCape && (
                      <Check size={12} className="cape-check" />
                    )}
                    <img src={cape.url} alt={cape.alias ?? "账号披风"} />
                    <span>{cape.alias ?? "我的披风"}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="wardrobe-cape-empty">此账号暂无可用披风</div>
            )}
            <button
              className="btn subtle wardrobe-cape-import"
              disabled={busy}
              onClick={() => void chooseTexture("cape")}
            >
              <ImagePlus size={14} /> 预览本地披风
            </button>
            {localCape && (
              <div className="wardrobe-row wardrobe-local-cape">
                <span>{localCape.name}</span>
                <button
                  className="btn subtle wardrobe-cape-clear"
                  onClick={() => setLocalCape(null)}
                >
                  <X size={12} /> 清除预览
                </button>
              </div>
            )}
            <p className="wardrobe-note">
              正版披风可切换账号已拥有的款式；本地披风文件用于试穿预览。
            </p>
          </GlassSurface>
        </div>
      </div>
      <SkinLibrary
        call={call}
        notify={notify}
        account={account}
        editable={profile.editable && !loading}
        disabled={busy || loading}
        variant={variant}
        selectedId={localSkin?.libraryId}
        draft={libraryDraft}
        onDraftClose={() => setLibraryDraft(null)}
        onSaveCurrent={() => void saveCurrentToLibrary()}
        onSelect={selectLibrarySkin}
        onApplied={(entry, result) => {
          setProfile({
            ...result,
            skins: result.skins ?? [],
            capes: result.capes ?? [],
          });
          selectLibrarySkin(entry);
        }}
        onRemoved={(id) => {
          setLocalSkin((previous) =>
            previous?.libraryId === id
              ? { url: previous.url, name: previous.name }
              : previous,
          );
        }}
        onBusyChange={setLibraryBusy}
      />
      {editorOpen && (
        <div
          className="wardrobe-editor-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="皮肤像素编辑器"
        >
          <GlassSurface as="div" className="wardrobe-editor">
            <header>
              <div>
                <h3>像素之间，创造你的角色</h3>
                <p className="muted wardrobe-editor-subtitle">
                  64 × 64 皮肤纹理 · 修改后可预览、导出或同步
                </p>
              </div>
              <button
                className="btn subtle"
                aria-label="关闭编辑器"
                onClick={() => setEditorOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="wardrobe-editor-body">
              <div className="wardrobe-pixel-wrap">
                <canvas
                  ref={editCanvas}
                  width={64}
                  height={64}
                  aria-label="可涂色编辑的皮肤像素画布"
                  onPointerDown={(event) => {
                    if (!editorReady.current) return;
                    dragging.current = true;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    history.current.push(
                      event.currentTarget
                        .getContext("2d")!
                        .getImageData(0, 0, 64, 64),
                    );
                    if (history.current.length > 16) history.current.shift();
                    draw(event);
                  }}
                  onPointerMove={draw}
                  onPointerUp={() => {
                    dragging.current = false;
                  }}
                  onPointerCancel={() => {
                    dragging.current = false;
                  }}
                />
                <div className="wardrobe-grid" />
              </div>
              <aside className="wardrobe-editor-side">
                <div>
                  <label htmlFor="wardrobe-brush-color">画笔颜色</label>
                  <div className="wardrobe-color">
                    <input
                      id="wardrobe-brush-color"
                      type="color"
                      value={brushColor}
                      onChange={(event) => {
                        setBrushColor(event.target.value);
                        setEraser(false);
                      }}
                    />
                    <span>{brushColor.toUpperCase()}</span>
                  </div>
                </div>
                <div>
                  <label htmlFor="wardrobe-brush-size">画笔大小</label>
                  <select
                    id="wardrobe-brush-size"
                    className="field wardrobe-brush-size"
                    value={brushSize}
                    onChange={(event) =>
                      setBrushSize(Number(event.target.value))
                    }
                  >
                    <option value={1}>1 × 1 像素</option>
                    <option value={2}>2 × 2 像素</option>
                    <option value={4}>4 × 4 像素</option>
                  </select>
                </div>
                <button
                  className={`btn ${eraser ? "primary" : "subtle"}`}
                  onClick={() => setEraser(!eraser)}
                >
                  <Eraser size={15} /> {eraser ? "橡皮擦已启用" : "橡皮擦"}
                </button>
                <button
                  className="btn subtle"
                  onClick={() => {
                    const previous = history.current.pop();
                    if (previous)
                      editCanvas.current
                        ?.getContext("2d")
                        ?.putImageData(previous, 0, 0);
                  }}
                >
                  <Undo2 size={15} /> 撤销上一笔
                </button>
                <p className="wardrobe-note">
                  每一格对应一个像素。图中为 Minecraft 原始 UV
                  展开纹理，透明区域会在模型上隐藏对应外层。
                </p>
              </aside>
            </div>
            <footer className="wardrobe-editor-footer">
              <button
                className="btn subtle"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await call("skin:exportEdited", { dataUrl: editedData() });
                  })
                }
              >
                <Download size={14} /> 导出 PNG
              </button>
              <div>
                <button
                  className="btn subtle"
                  disabled={busy}
                  onClick={() => {
                    try {
                      setLibraryDraft({
                        dataUrl: editedData(),
                        variant,
                        name: "我的编辑皮肤",
                      });
                    } catch (error: any) {
                      notify(error.message);
                    }
                  }}
                >
                  <BookmarkPlus size={14} /> 保存到皮肤库
                </button>
                <button
                  className="btn subtle"
                  onClick={() => {
                    try {
                      const url = editedData();
                      setEditorOpen(false);
                      setLocalSkin({ url, name: "我的编辑皮肤.png" });
                    } catch (error: any) {
                      notify(error.message);
                    }
                  }}
                >
                  应用到预览
                </button>
                {profile.editable && (
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const result = await call("skin:saveEdited", {
                          id: accountId,
                          dataUrl: editedData(),
                          variant,
                        });
                        setEditorOpen(false);
                        setLocalSkin(null);
                        setProfile(result);
                        notify("编辑后的皮肤已同步至正版账号。");
                      })
                    }
                  >
                    {busy ? (
                      <LoaderCircle size={14} className="wardrobe-spin" />
                    ) : (
                      <Upload size={14} />
                    )}{" "}
                    同步正版账号
                  </button>
                )}
              </div>
            </footer>
          </GlassSurface>
        </div>
      )}
    </div>
  );
}
