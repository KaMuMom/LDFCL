import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Layers3,
  Languages,
  Package,
  Search,
  Sparkles,
  Star,
  WandSparkles,
} from "lucide-react";
import type { FavoriteMod, Instance } from "../../shared/types";
import ModpackVersionPicker from "./ModpackVersionPicker";
import ModInstallPicker from "./ModInstallPicker";
import { GlassSurface } from "../ui/Glass";
import "./resources.css";

export type ContentKind = "mod" | "modpack" | "resourcepack" | "shader";
type Kind = ContentKind;
const kinds: {
  id: Kind;
  name: string;
  subtitle: string;
  icon: typeof Package;
}[] = [
  { id: "mod", name: "模组", subtitle: "给你的世界，更多可能", icon: Package },
  {
    id: "modpack",
    name: "整合包",
    subtitle: "一次安装，开启全新冒险",
    icon: Layers3,
  },
  {
    id: "resourcepack",
    name: "资源包",
    subtitle: "从每一个像素重新发现世界",
    icon: Sparkles,
  },
  {
    id: "shader",
    name: "光影包",
    subtitle: "让方块世界，光彩流动",
    icon: WandSparkles,
  },
];
type Props = {
  instance?: Instance;
  instances?: Instance[];
  call: (method: string, payload?: any) => Promise<any>;
  notify: (message: string) => void;
  onInstalled: () => void;
  initialKind?: ContentKind;
  embedded?: boolean;
  active?: boolean;
};
const number = (n: number) =>
  n >= 1000000
    ? `${(n / 1000000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}K`
      : String(n || 0);

export default function ContentBrowser({
  instance,
  instances,
  call,
  notify,
  onInstalled,
  initialKind = "mod",
  embedded = false,
  active = true,
}: Props) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [compatible, setCompatible] = useState(true);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{
    hits: any[];
    total_hits: number;
    queryTranslation?: {
      originalQuery: string;
      effectiveQuery: string;
      translated: boolean;
    };
  }>({
    hits: [],
    total_hits: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState<string[]>([]);
  const [installed, setInstalled] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const [packProject, setPackProject] = useState<any>();
  const [modProject, setModProject] = useState<any>();
  const [favorites, setFavorites] = useState<FavoriteMod[]>([]);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState<string[]>([]);
  const [favoritesError, setFavoritesError] = useState("");
  const favoritesRequest = useRef(0);
  const alive = useRef(active);
  const mounted = useRef(true);
  const request = useRef(0);
  const selected = kinds.find((k) => k.id === kind)!;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    alive.current = active;
    if (!active) {
      favoritesRequest.current++;
      setFavoriteBusy([]);
    }
    return () => {
      alive.current = false;
    };
  }, [active]);
  useEffect(() => {
    if (!active || kind !== "mod") return;
    const id = ++favoritesRequest.current;
    setFavoritesError("");
    call("mod-favorites:list")
      .then((items) => {
        if (alive.current && favoritesRequest.current === id)
          setFavorites(items);
      })
      .catch((error) => {
        if (alive.current && favoritesRequest.current === id)
          setFavoritesError(error.message || "无法读取模组收藏");
      });
    return () => {
      favoritesRequest.current++;
    };
  }, [active, kind, retry]);
  useEffect(() => {
    const id = ++request.current;
    if (!active || (kind === "mod" && onlyFavorites)) {
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    call("content:search", {
      query: submitted,
      type: kind,
      version: compatible ? instance?.version : undefined,
      loader: compatible ? instance?.loader : undefined,
      offset,
    })
      .then((data) => {
        if (request.current === id) setResult(data);
      })
      .catch((e) => {
        if (request.current === id) {
          setError(e.message || "无法连接内容服务");
          setResult({ hits: [], total_hits: 0 });
        }
      })
      .finally(() => {
        if (request.current === id) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [
    kind,
    submitted,
    offset,
    compatible,
    instance?.id,
    retry,
    active,
    onlyFavorites,
  ]);
  useEffect(() => {
    setInstalled([]);
  }, [instance?.id, kind]);
  useEffect(() => {
    if (!active || kind !== "modpack") setPackProject(undefined);
    if (!active || kind !== "mod") setModProject(undefined);
  }, [active, kind]);

  async function toggleFavorite(project: any) {
    const saved = favorites.some(
      (item) => item.projectId === project.project_id,
    );
    const id = ++favoritesRequest.current;
    setFavoriteBusy((items) => [...items, project.project_id]);
    try {
      const items = await call("mod-favorites:set", {
        saved: !saved,
        project: {
          projectId: project.project_id,
          slug: project.slug,
          title: project.title,
          displayName: project.displayName,
          description: project.displayDescription || project.description,
          iconUrl: project.icon_url,
          author: project.author,
        },
      });
      if (alive.current && favoritesRequest.current === id) {
        setFavorites(items);
        setFavoritesError("");
      }
    } catch (error: any) {
      if (alive.current) notify(error.message || "收藏保存失败");
    } finally {
      if (alive.current)
        setFavoriteBusy((items) =>
          items.filter((item) => item !== project.project_id),
        );
    }
  }
  const favoriteHits = favorites
    .filter(
      (item) =>
        !submitted ||
        `${item.title} ${item.displayName || ""} ${item.description || ""} ${item.slug}`
          .toLocaleLowerCase()
          .includes(submitted.toLocaleLowerCase()),
    )
    .map((item) => ({
      project_id: item.projectId,
      slug: item.slug,
      title: item.title,
      displayName: item.displayName,
      description: item.description,
      icon_url: item.iconUrl,
      author: item.author,
    }));
  const shown =
    kind === "mod" && onlyFavorites
      ? {
          hits: favoriteHits.slice(offset, offset + 20),
          total_hits: favoriteHits.length,
          queryTranslation: undefined,
        }
      : result;
  useEffect(() => {
    if (
      kind === "mod" &&
      onlyFavorites &&
      offset > 0 &&
      offset >= favoriteHits.length
    )
      setOffset(Math.max(0, Math.floor((favoriteHits.length - 1) / 20) * 20));
  }, [kind, onlyFavorites, offset, favoriteHits.length]);

  async function install(
    project: any,
    versionId?: string,
    target = instance,
    installKind = kind,
  ): Promise<boolean> {
    if (installKind !== "modpack" && !target) {
      notify("请先创建并选择一个游戏实例");
      return false;
    }
    if (installKind === "mod" && target?.loader === "vanilla") {
      notify("模组需要 Fabric、Quilt 或 Forge 实例，请先安装模组加载器");
      return false;
    }
    setInstalling((ids) => [...ids, project.project_id]);
    try {
      const report = await call(
        installKind === "modpack" ? "pack:install" : "content:install",
        {
          projectId: project.project_id,
          instanceId: target?.id,
          versionId,
        },
      );
      if (mounted.current) {
        setInstalled((ids) => [...ids, project.project_id]);
      }
      notify(
        installKind === "modpack"
          ? `${project.displayName || project.title} 已安装为独立实例`
          : installKind === "mod"
            ? `${project.displayName || project.title} 已安装到 ${target?.name}${report?.dependencies?.length ? `，已补齐 ${report.dependencies.length} 个必需前置模组` : ""}`
            : `${project.displayName || project.title} 安装完成`,
      );
      onInstalled();
      return true;
    } catch (e: any) {
      notify(e.message || "安装失败");
      if (installKind === "modpack" || installKind === "mod") throw e;
      return false;
    } finally {
      if (mounted.current)
        setInstalling((ids) => ids.filter((id) => id !== project.project_id));
    }
  }
  const search = (event: React.FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setSubmitted(query.trim());
  };

  return (
    <div className="content-browser">
      {!embedded && (
        <>
          <div className="page-heading">
            <div>
              <div className="eyebrow">DISCOVER MORE</div>
              <h1>探索与下载</h1>
              <p className="muted">{selected.subtitle}。内容来自 Modrinth。</p>
            </div>
            <button
              className="btn subtle"
              onClick={() =>
                call("external", { url: "https://modrinth.com" }).catch(
                  (e: any) => notify(e.message),
                )
              }
            >
              访问 Modrinth <ArrowUpRight size={15} />
            </button>
          </div>
          <GlassSurface as="div" className="content-tabs">
            {kinds.map((tab) => (
              <button
                key={tab.id}
                className={`content-tab ${kind === tab.id ? "active" : ""}`}
                onClick={() => {
                  setKind(tab.id);
                  setOffset(0);
                  setInstalled([]);
                }}
              >
                <tab.icon size={17} />
                {tab.name}
              </button>
            ))}
          </GlassSurface>
        </>
      )}
      <GlassSurface as="form" onSubmit={search} className="content-toolbar">
        <div className="content-search">
          <Search size={18} />
          <input
            className="field"
            aria-label="搜索内容"
            placeholder={
              kind === "mod"
                ? "搜索中文名、原名或关键词，如 钠 / Sodium…"
                : `搜索${selected.name}名称或关键词…`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="btn primary" type="submit">
          搜索
        </button>
        {kind === "mod" && (
          <button
            type="button"
            className={`btn subtle favorites-filter ${onlyFavorites ? "active" : ""}`}
            aria-pressed={onlyFavorites}
            onClick={() => {
              setOnlyFavorites((value) => !value);
              setOffset(0);
            }}
          >
            <Star size={15} fill={onlyFavorites ? "currentColor" : "none"} />
            只看收藏
          </button>
        )}
        {instance && (
          <label className="compat-toggle">
            <input
              type="checkbox"
              checked={compatible}
              disabled={kind === "mod" && onlyFavorites}
              onChange={(e) => {
                setCompatible(e.target.checked);
                setOffset(0);
              }}
            />
            <span>
              匹配 {instance.version}
              {kind === "mod" ? ` · ${instance.loader}` : ""}
            </span>
          </label>
        )}
      </GlassSurface>
      <div className="content-context">
        <span className="muted">
          {loading
            ? "正在发现内容…"
            : `${shown.total_hits.toLocaleString()} 个${onlyFavorites && kind === "mod" ? "收藏" : selected.name}`}
        </span>
        <span className="badge">
          {kind === "modpack"
            ? "安装为独立游戏实例"
            : kind === "mod"
              ? "选择目标游戏版本后安装"
              : instance
                ? `安装到 ${instance.name}`
                : "请先选择游戏实例"}
        </span>
      </div>
      {kind === "mod" && (
        <div className="notice translation-notice">
          <Languages size={16} />
          <span>
            常用模组提供中文名称与简介，原名始终保留；暂无译文时显示原文。
            {shown.queryTranslation?.translated && (
              <>
                {" "}
                已按「{shown.queryTranslation.effectiveQuery}」检索「
                {shown.queryTranslation.originalQuery}」。
              </>
            )}
          </span>
        </div>
      )}
      {kind === "mod" && favoritesError && (
        <div className="notice danger" role="alert">
          {favoritesError}
          <button
            className="btn subtle"
            onClick={() => setRetry((value) => value + 1)}
          >
            重新读取收藏
          </button>
        </div>
      )}
      {error ? (
        <GlassSurface as="div" className="content-empty">
          <Package size={36} />
          <h3>暂时无法获取内容</h3>
          <p className="muted">{error}</p>
          <button
            className="btn"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </button>
        </GlassSurface>
      ) : loading ? (
        <div className="content-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <GlassSurface
              as="div"
              className="content-card content-skeleton"
              key={i}
            >
              <div className="skeleton-icon" />
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
              <div className="skeleton-line" />
            </GlassSurface>
          ))}
        </div>
      ) : shown.hits.length === 0 ? (
        <GlassSurface as="div" className="content-empty">
          <Search size={36} />
          <h3>还没有找到相关内容</h3>
          <p className="muted">
            {kind === "mod" && onlyFavorites
              ? "点击模组卡片的星标收藏常用模组，收藏会保存在本地。"
              : "试试其他关键词，或取消版本兼容性筛选。"}
          </p>
        </GlassSurface>
      ) : (
        <div className="content-grid">
          {shown.hits.map((project) => {
            const busy = installing.includes(project.project_id),
              done = installed.includes(project.project_id);
            return (
              <GlassSurface
                as="article"
                className="content-card"
                key={project.project_id}
              >
                <div className="content-card-head">
                  {project.icon_url ? (
                    <img
                      src={project.icon_url}
                      alt=""
                      className="project-icon"
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.visibility = "hidden";
                      }}
                    />
                  ) : (
                    <div className="project-icon fallback">
                      <selected.icon size={27} />
                    </div>
                  )}
                  <div className="content-project-identity">
                    <h3
                      title={`${project.displayName || project.title} · ${project.title}`}
                    >
                      {project.displayName || project.title}
                    </h3>
                    {project.translation?.status === "translated" && (
                      <div
                        className="muted project-original-name"
                        title="项目原名"
                      >
                        {project.originalName || project.title}
                      </div>
                    )}
                    <span className="muted content-author">
                      by {project.author}
                    </span>
                  </div>
                  <button
                    className="icon-btn"
                    title="查看项目页面"
                    aria-label={`查看 ${project.title}`}
                    onClick={() =>
                      call("external", {
                        url: `https://modrinth.com/${kind}/${encodeURIComponent(project.slug)}`,
                      }).catch((e: any) => notify(e.message))
                    }
                  >
                    <ArrowUpRight size={16} />
                  </button>
                  {kind === "mod" && (
                    <button
                      className={`icon-btn favorite-toggle ${favorites.some((item) => item.projectId === project.project_id) ? "saved" : ""}`}
                      title={
                        favorites.some(
                          (item) => item.projectId === project.project_id,
                        )
                          ? "取消收藏"
                          : "收藏模组"
                      }
                      aria-label={`${favorites.some((item) => item.projectId === project.project_id) ? "取消收藏" : "收藏"} ${project.title}`}
                      aria-pressed={favorites.some(
                        (item) => item.projectId === project.project_id,
                      )}
                      disabled={favoriteBusy.length > 0}
                      onClick={() => void toggleFavorite(project)}
                    >
                      <Star
                        size={17}
                        fill={
                          favorites.some(
                            (item) => item.projectId === project.project_id,
                          )
                            ? "currentColor"
                            : "none"
                        }
                      />
                    </button>
                  )}
                </div>
                <p
                  className="project-description"
                  title={project.originalDescription || project.description}
                >
                  {project.displayDescription || project.description}
                </p>
                {kind === "mod" && (
                  <div
                    className="project-translation"
                    title={
                      project.translation?.source
                        ? `${project.translation.source} · 中文简介许可：${project.translation.license || "未指定"}`
                        : "原项目说明"
                    }
                  >
                    {project.translation?.status === "translated"
                      ? "中文简介 · 保留原名"
                      : "暂无中文 · 显示原文"}
                  </div>
                )}
                {kind === "mod" &&
                  project.translation?.status === "translated" &&
                  project.originalDescription && (
                    <details className="project-original">
                      <summary>查看原文</summary>
                      <p>{project.originalDescription}</p>
                    </details>
                  )}
                <div className="project-categories">
                  {(project.display_categories || project.categories || [])
                    .slice(0, 3)
                    .map((category: string) => (
                      <span key={category} className="badge">
                        {category}
                      </span>
                    ))}
                </div>
                <div className="content-card-bottom">
                  <span className="muted">
                    <Download size={13} /> {number(project.downloads)}
                  </span>
                  <button
                    className={`btn ${done ? "subtle" : "primary"}`}
                    disabled={
                      busy || (done && kind !== "modpack" && kind !== "mod")
                    }
                    onClick={() =>
                      kind === "modpack"
                        ? setPackProject(project)
                        : kind === "mod"
                          ? setModProject(project)
                          : void install(project)
                    }
                  >
                    {busy ? (
                      <>
                        <span className="spinner small" /> 安装中
                      </>
                    ) : kind === "modpack" ? (
                      <>
                        <Layers3 size={15} /> 选择版本
                      </>
                    ) : kind === "mod" ? (
                      <>
                        <Package size={15} />
                        选择安装位置
                      </>
                    ) : done ? (
                      <>
                        <Check size={15} /> 已安装
                      </>
                    ) : (
                      <>
                        <ArrowDownToLine size={15} /> 安装
                      </>
                    )}
                  </button>
                </div>
              </GlassSurface>
            );
          })}
        </div>
      )}
      {shown.total_hits > 20 && !loading && (
        <div className="content-pagination">
          <button
            className="btn subtle"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            <ChevronLeft size={16} />
            上一页
          </button>
          <span className="muted">
            {Math.floor(offset / 20) + 1} / {Math.ceil(shown.total_hits / 20)}
          </span>
          <button
            className="btn subtle"
            disabled={offset + 20 >= shown.total_hits}
            onClick={() => setOffset(offset + 20)}
          >
            下一页
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      {active && kind === "modpack" && packProject && (
        <ModpackVersionPicker
          key={packProject.project_id}
          project={packProject}
          call={call}
          onClose={() => setPackProject(undefined)}
          onInstall={(versionId) => install(packProject, versionId)}
        />
      )}
      {active && kind === "mod" && modProject && (
        <ModInstallPicker
          key={modProject.project_id}
          project={modProject}
          instances={instances || (instance ? [instance] : [])}
          initialInstanceId={instance?.id}
          call={call}
          onClose={() => setModProject(undefined)}
          onInstall={(target, versionId) =>
            install(modProject, versionId, target, "mod")
          }
        />
      )}
    </div>
  );
}
