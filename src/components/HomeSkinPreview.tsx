import { memo, useEffect, useMemo, useRef, useState } from "react";
import { IdleAnimation, SkinViewer } from "skinview3d";
import { ChevronDown, Pause, Play, RefreshCw, UserRound } from "lucide-react";
import type { Account, LauncherAPI } from "../../shared/types";
import { defaultSkinTexture } from "../../shared/default-skin";
import { GlassSurface } from "../ui/Glass";
import {
  manageSkinPreview,
  type SkinPreviewRenderer,
} from "../ui/skin-preview-renderer";
import "./home-skin.css";

type Props = {
  accounts: Account[];
  selectedAccountId?: string;
  call: LauncherAPI["call"];
  notify: (message: string) => void;
  onSelect: (id: string) => Promise<void>;
  onManage: () => void;
};
type Appearance = {
  owner: string;
  skin?: string;
  cape?: string;
  slim: boolean;
};

function imageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.hostname === "textures.minecraft.net" && url.protocol === "http:")
      url.protocol = "https:";
    return ["https:", "data:", "blob:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function appearance(
  owner: string,
  profile?: { skins?: any[]; capes?: any[] },
): Appearance {
  const skins = Array.isArray(profile?.skins) ? profile.skins : [];
  const capes = Array.isArray(profile?.capes) ? profile.capes : [];
  const skin = skins.find((item) => item?.state === "ACTIVE") ?? skins[0];
  const cape = capes.find((item) => item?.state === "ACTIVE");
  return {
    owner,
    skin: imageUrl(skin?.url),
    cape: imageUrl(cape?.url),
    slim: String(skin?.variant).toUpperCase() === "SLIM",
  };
}

function HomeSkinPreview({
  accounts,
  selectedAccountId,
  call,
  notify,
  onSelect,
  onManage,
}: Props) {
  const account =
    accounts.find((item) => item.id === selectedAccountId) ?? accounts[0];
  const accountId = account?.id ?? "";
  const defaultTexture = useMemo(defaultSkinTexture, []);
  const [profile, setProfile] = useState<Appearance>(() =>
    appearance(accountId, account),
  );
  const [rotating, setRotating] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [usingDefault, setUsingDefault] = useState(true);
  const [switching, setSwitching] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [textureRevision, setTextureRevision] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fallbackCanvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<SkinViewer | null>(null);
  const renderer = useRef<SkinPreviewRenderer | null>(null);
  const profileGeneration = useRef(0);
  const textureGeneration = useRef(0);
  const switchingRef = useRef(false);
  const mounted = useRef(true);
  const current =
    profile.owner === accountId ? profile : appearance(accountId, account);
  const skin = current.skin ?? defaultTexture;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = ++profileGeneration.current;
    setRefreshing(false);
    setProfile(appearance(accountId, account));
    if (!accountId || account?.type === "offline") return;
    // The service returns only public skins/capes. Its token-bearing launch account never reaches here.
    void call<{ skins?: any[]; capes?: any[] }>("skin:profile", {
      id: accountId,
    })
      .then((result) => {
        if (mounted.current && generation === profileGeneration.current)
          setProfile(appearance(accountId, result));
      })
      .catch(() => {
        if (mounted.current && generation === profileGeneration.current)
          setProfile({ owner: accountId, slim: false });
      });
    return () => {
      profileGeneration.current++;
    };
    // Account list refreshes should not trigger another login/profile request.
  }, [accountId, call]);

  useEffect(() => {
    if (!canvas.current || !stage.current) return;
    let instance: SkinViewer;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    try {
      instance = new SkinViewer({
        canvas: canvas.current,
        width: Math.max(1, stage.current.clientWidth),
        height: Math.max(260, stage.current.clientHeight),
        zoom: 0.8,
        fov: 40,
        pixelRatio: 1,
        renderPaused: true,
        enableControls: true,
      });
      instance.playerObject.rotation.y = -0.24;
      instance.autoRotate = false;
      instance.autoRotateSpeed = 0.28;
      instance.controls.enablePan = false;
      instance.controls.enableZoom = false;
      instance.controls.minPolarAngle = Math.PI / 3;
      instance.controls.maxPolarAngle = (Math.PI * 2) / 3;
      viewer.current = instance;
    } catch {
      setFallback(true);
      return;
    }
    const updateMotion = () => {
      instance.animation = motion.matches ? null : new IdleAnimation();
      if (instance.animation) instance.animation.speed = 0.55;
      renderer.current?.invalidate();
    };
    updateMotion();
    motion.addEventListener("change", updateMotion);
    const rendering = manageSkinPreview(instance, stage.current);
    renderer.current = rendering;
    return () => {
      textureGeneration.current++;
      rendering.dispose();
      renderer.current = null;
      motion.removeEventListener("change", updateMotion);
      instance.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    const generation = ++textureGeneration.current;
    const instance = viewer.current;
    instance?.loadSkin(null);
    instance?.loadCape(null);
    renderer.current?.invalidate();
    setUsingDefault(true);
    let skinImage: HTMLImageElement | undefined;
    let capeImage: HTMLImageElement | undefined;
    const alive = () =>
      mounted.current &&
      generation === textureGeneration.current &&
      !instance?.disposed;
    const showSkin = (url: string, isDefault: boolean, after?: () => void) => {
      skinImage = new Image();
      skinImage.crossOrigin = "anonymous";
      skinImage.onload = () => {
        if (!alive()) return;
        if (![32, 64].includes(skinImage!.height) || skinImage!.width !== 64) {
          if (!isDefault) showSkin(defaultTexture, true);
          return;
        }
        try {
          if (instance)
            instance.loadSkin(skinImage!, {
              model: !isDefault && current.slim ? "slim" : "default",
            });
          renderer.current?.invalidate();
          const target = fallbackCanvas.current;
          if (target) {
            const context = target.getContext("2d")!;
            context.clearRect(0, 0, target.width, target.height);
            context.imageSmoothingEnabled = false;
            const parts = [
              [8, 8, 8, 8, 24, 4, 16, 16],
              [20, 20, 8, 12, 24, 20, 16, 24],
              [44, 20, 4, 12, 16, 20, 8, 24],
              [36, 52, 4, 12, 40, 20, 8, 24],
              [4, 20, 4, 12, 24, 44, 8, 24],
              [20, 52, 4, 12, 32, 44, 8, 24],
            ];
            parts.forEach(([sx, sy, sw, sh, x, y, w, h]) =>
              context.drawImage(skinImage!, sx, sy, sw, sh, x, y, w, h),
            );
          }
          setUsingDefault(isDefault);
          after?.();
        } catch {
          if (!isDefault) showSkin(defaultTexture, true);
        }
      };
      skinImage.onerror = () => {
        if (alive() && !isDefault) showSkin(defaultTexture, true);
      };
      skinImage.src = url;
    };
    // Display the built-in appearance immediately while a new account's remote image loads.
    showSkin(
      defaultTexture,
      true,
      current.skin ? () => showSkin(skin, false) : undefined,
    );
    if (current.cape && instance) {
      capeImage = new Image();
      capeImage.crossOrigin = "anonymous";
      capeImage.onload = () => {
        if (alive()) {
          try {
            instance.loadCape(capeImage!);
          } catch {
            instance.loadCape(null);
          }
          renderer.current?.invalidate();
        }
      };
      capeImage.onerror = () => {
        if (alive()) {
          instance.loadCape(null);
          renderer.current?.invalidate();
        }
      };
      capeImage.src = current.cape;
    }
    return () => {
      textureGeneration.current++;
      if (skinImage) {
        skinImage.onload = null;
        skinImage.onerror = null;
      }
      if (capeImage) {
        capeImage.onload = null;
        capeImage.onerror = null;
      }
    };
  }, [
    skin,
    current.cape,
    current.slim,
    defaultTexture,
    fallback,
    textureRevision,
  ]);

  useEffect(() => {
    renderer.current?.setRotating(rotating);
  }, [rotating]);

  const refreshAppearance = async () => {
    const generation = ++profileGeneration.current;
    setRefreshing(true);
    try {
      const result =
        accountId && account?.type !== "offline"
          ? await call<{ skins?: any[]; capes?: any[] }>("skin:profile", {
              id: accountId,
            })
          : account;
      if (mounted.current && generation === profileGeneration.current) {
        setProfile(appearance(accountId, result));
        setTextureRevision((value) => value + 1);
      }
    } catch (error: any) {
      if (mounted.current && generation === profileGeneration.current)
        notify(error.message || "角色外观刷新失败，请稍后重试。");
    } finally {
      if (mounted.current && generation === profileGeneration.current)
        setRefreshing(false);
    }
  };

  const select = async (id: string) => {
    if (!id || id === accountId || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(id);
    try {
      await onSelect(id);
    } catch (error: any) {
      notify(
        String(error.message || "账号切换失败").replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    } finally {
      switchingRef.current = false;
      if (mounted.current) setSwitching("");
    }
  };

  return (
    <GlassSurface
      as="section"
      className="home-skin-panel"
      aria-label="我的角色"
    >
      <div className="home-skin-heading">
        <span>我的角色</span>
        <div className="home-skin-actions">
          <button
            className="home-skin-motion"
            aria-label="刷新角色外观"
            title="刷新角色外观"
            disabled={refreshing}
            onClick={() => void refreshAppearance()}
          >
            <RefreshCw size={14} />
          </button>
          {!fallback && (
            <button
              className="home-skin-motion"
              aria-label={rotating ? "暂停自动旋转" : "开启自动旋转"}
              title={rotating ? "暂停自动旋转" : "开启自动旋转"}
              aria-pressed={rotating}
              onClick={() => setRotating(!rotating)}
            >
              {rotating ? <Pause size={14} /> : <Play size={14} />}
            </button>
          )}
        </div>
      </div>
      <div className="home-skin-viewport" ref={stage}>
        <canvas ref={canvas} aria-label="首页角色皮肤预览" hidden={fallback} />
        {fallback && (
          <canvas
            ref={fallbackCanvas}
            className="home-skin-fallback"
            width={64}
            height={80}
            aria-label="首页角色皮肤静态预览"
          />
        )}
      </div>
      <p className="home-skin-caption">
        {usingDefault ? "默认外观" : "我的皮肤"}
        {!fallback && " · 拖动旋转"}
      </p>
      <div className="home-account-row">
        <div className="home-account-select">
          <UserRound size={15} />
          <select
            aria-label="首页账号"
            value={switching || accountId}
            disabled={!accounts.length || !!switching}
            onChange={(event) => void select(event.target.value)}
          >
            {!accounts.length && <option value="">未登录</option>}
            {accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
        <button
          className={`home-account-manage ${accounts.length ? "" : "home-account-add"}`}
          aria-label="管理账号"
          title="管理账号"
          onClick={onManage}
        >
          {accounts.length ? <UserRound size={16} /> : "添加账号"}
        </button>
      </div>
      <div className="home-account-type">
        {account
          ? {
              microsoft: "正版账号",
              offline: "离线账号",
              yggdrasil: "皮肤站账号",
            }[account.type]
          : "选择你的冒险身份"}
      </div>
    </GlassSurface>
  );
}

export default memo(HomeSkinPreview);
