import fs from "node:fs/promises";
import path from "node:path";

export interface ModTranslationEntry {
  projectId?: string;
  slug?: string;
  modIds?: string[];
  originalName: string;
  nameZh: string;
  descriptionZh: string;
  aliases?: string[];
  source?: string;
  sourceUrl?: string;
  license?: string;
}

export interface LocalizedModFields {
  displayName: string;
  displayDescription: string;
  originalName: string;
  originalDescription: string;
  nameZh?: string;
  descriptionZh?: string;
  translation: {
    status: "translated" | "unavailable";
    source: string;
    license?: string;
    sourceUrl?: string;
    matchedBy?: "projectId" | "slug" | "modId";
    notice: string;
  };
}

type Builtin = [
  slug: string,
  modIds: string[],
  original: string,
  chinese: string,
  description: string,
  aliases?: string[],
  projectId?: string,
];

// Names use common Chinese community terminology. Descriptions below are original
// LDFCL summaries under this project's MIT license, not scraped upstream prose.
// CFPAOrg/Minecraft-Mod-Language-Package was reviewed as a community reference;
// its CC BY-NC-SA 4.0 language files are not copied or bundled in this catalogue.
const builtinRows: Builtin[] = [
  [
    "sodium",
    ["sodium"],
    "Sodium",
    "钠",
    "优化客户端方块渲染，提升帧率并减少部分渲染卡顿。",
    ["钠优化"],
    "AANobbMI",
  ],
  [
    "lithium",
    ["lithium"],
    "Lithium",
    "锂",
    "优化方块更新、实体等游戏逻辑，适用于支持它的客户端或服务端。",
    ["锂优化"],
  ],
  [
    "fabric-api",
    ["fabric-api", "fabric_api"],
    "Fabric API",
    "Fabric API 基础库",
    "为 Fabric 模组提供常用接口；许多 Fabric 模组需要先安装它。",
    ["fabric基础库", "fabric api"],
  ],
  [
    "iris",
    ["iris"],
    "Iris Shaders",
    "Iris 光影",
    "为支持的 Minecraft 版本加载光影包，通常与钠搭配使用。",
    ["鸢尾", "iris光影"],
  ],
  [
    "modmenu",
    ["modmenu"],
    "Mod Menu",
    "模组菜单",
    "在游戏中查看已安装模组，并打开模组提供的配置界面。",
    ["mod菜单"],
  ],
  [
    "create",
    ["create"],
    "Create",
    "机械动力",
    "通过齿轮、传动和各类机械组件搭建自动化设备与生产线。",
  ],
  [
    "create-fabric",
    ["create"],
    "Create Fabric",
    "机械动力 · Fabric",
    "机械动力的 Fabric 移植版本，通过传动与机械组件构建自动化设备。",
    ["机械动力fabric"],
  ],
  [
    "jei",
    ["jei"],
    "Just Enough Items",
    "JEI 物品管理器",
    "在游戏内浏览物品、配方和用途，便于查询合成方法。",
    ["jei", "物品管理器"],
  ],
  [
    "rei",
    ["roughlyenoughitems"],
    "Roughly Enough Items",
    "REI 物品管理器",
    "提供物品列表、配方与用途查询，并支持扩展插件。",
    ["rei"],
  ],
  [
    "emi",
    ["emi"],
    "EMI",
    "EMI 物品与配方浏览器",
    "浏览物品配方与用途，并辅助规划制作所需材料。",
    ["emi"],
  ],
  [
    "jade",
    ["jade"],
    "Jade",
    "玉",
    "在屏幕上显示所指方块、实体及相关模组提供的信息。",
    ["玉信息显示"],
  ],
  [
    "wthit",
    ["wthit"],
    "WTHIT",
    "WTHIT 方块信息提示",
    "显示准星所指方块和实体的信息，便于辨识模组内容。",
    ["这是什么"],
  ],
  [
    "appleskin",
    ["appleskin"],
    "AppleSkin",
    "苹果皮",
    "显示食物恢复量、饱和度等与饥饿机制有关的辅助信息。",
  ],
  [
    "ferrite-core",
    ["ferritecore"],
    "FerriteCore",
    "铁氧体磁芯",
    "减少部分游戏数据结构的内存占用，适合模组较多的环境。",
    ["磁芯"],
  ],
  [
    "modernfix",
    ["modernfix"],
    "ModernFix",
    "ModernFix 综合优化",
    "提供针对加载速度、内存和兼容问题的一组修复与优化。",
    ["现代修复"],
  ],
  [
    "entityculling",
    ["entityculling"],
    "Entity Culling",
    "实体渲染剔除",
    "跳过被遮挡实体和方块实体的部分渲染工作。",
    ["实体剔除"],
  ],
  [
    "immediatelyfast",
    ["immediatelyfast"],
    "ImmediatelyFast",
    "ImmediatelyFast 即时渲染优化",
    "优化部分即时模式渲染过程，改善界面及相关渲染性能。",
    ["即时优化"],
  ],
  [
    "dynamic-fps",
    ["dynamic_fps"],
    "Dynamic FPS",
    "动态帧率",
    "在窗口失去焦点或后台运行时降低资源占用。",
  ],
  [
    "indium",
    ["indium"],
    "Indium",
    "铟",
    "为部分钠版本补充 Fabric 渲染接口兼容支持；是否需要取决于游戏和钠版本。",
  ],
  [
    "phosphor",
    ["phosphor"],
    "Phosphor",
    "磷",
    "优化支持版本中的光照计算，降低区块光照处理开销。",
  ],
  [
    "starlight",
    ["starlight"],
    "Starlight",
    "星光",
    "替换支持版本中的光照实现，改善区块光照处理效率。",
  ],
  [
    "cloth-config",
    ["cloth-config", "cloth_config"],
    "Cloth Config API",
    "Cloth Config 配置界面库",
    "为模组提供图形化配置界面的基础组件。",
    ["布料配置", "cloth配置"],
  ],
  [
    "architectury-api",
    ["architectury"],
    "Architectury API",
    "Architectury 跨平台基础库",
    "为同时支持多种模组加载器的模组提供通用接口。",
    ["架构基础库"],
  ],
  [
    "yacl",
    ["yet_another_config_lib_v3", "yet_another_config_lib"],
    "YetAnotherConfigLib",
    "YACL 配置界面库",
    "供其他模组构建和保存图形化配置选项。",
    ["yacl"],
  ],
  [
    "sodium-extra",
    ["sodium_extra"],
    "Sodium Extra",
    "钠附加",
    "为钠相关的画面设置补充额外选项；需要匹配的依赖版本。",
  ],
  [
    "reeses-sodium-options",
    ["reeses_sodium_options"],
    "Reese's Sodium Options",
    "Reese 的钠设置界面",
    "重新整理钠的视频设置界面，改善选项浏览体验。",
    ["钠设置界面"],
  ],
  [
    "xaeros-minimap",
    ["xaerominimap"],
    "Xaero's Minimap",
    "Xaero 的小地图",
    "在游戏界面显示小地图与标记点，便于导航和定位。",
    ["xaero小地图"],
  ],
  [
    "xaeros-world-map",
    ["xaeroworldmap"],
    "Xaero's World Map",
    "Xaero 的世界地图",
    "记录探索过的区域，并以可缩放的大地图查看。",
    ["xaero世界地图"],
  ],
  [
    "journeymap",
    ["journeymap"],
    "JourneyMap",
    "旅行地图",
    "记录探索区域并提供地图、标记点等导航功能。",
  ],
  [
    "mouse-tweaks",
    ["mousetweaks"],
    "Mouse Tweaks",
    "鼠标手势",
    "改进背包中拖动、滚轮和批量移动物品的操作。",
  ],
  [
    "inventory-profiles-next",
    ["inventoryprofilesnext"],
    "Inventory Profiles Next",
    "背包配置管理器",
    "提供物品整理、背包布局及补充物品等辅助功能。",
    ["ipn", "背包整理"],
  ],
  [
    "betterf3",
    ["betterf3"],
    "BetterF3",
    "更好的 F3",
    "将调试信息重新排版，支持分组与显示配置。",
    ["更好的f3"],
  ],
  [
    "zoomify",
    ["zoomify"],
    "Zoomify",
    "Zoomify 缩放",
    "提供可配置的视野缩放、平滑过渡等观察辅助功能。",
    ["缩放"],
  ],
  [
    "continuity",
    ["continuity"],
    "Continuity",
    "连接纹理",
    "为资源包提供连接纹理等渲染功能，需要匹配的渲染环境。",
  ],
  [
    "lambdynamiclights",
    ["lambdynlights"],
    "LambDynamicLights",
    "Lamb 动态光源",
    "让手持或掉落的发光物品等内容产生动态照明效果。",
    ["动态光源"],
  ],
  [
    "sophisticated-backpacks",
    ["sophisticatedbackpacks"],
    "Sophisticated Backpacks",
    "精妙背包",
    "添加可升级背包，并提供多种物品存储与处理扩展。",
  ],
  [
    "sophisticated-core",
    ["sophisticatedcore"],
    "Sophisticated Core",
    "精妙核心",
    "为精妙系列模组提供共用功能与基础组件。",
  ],
  [
    "waystones",
    ["waystones"],
    "Waystones",
    "传送石碑",
    "添加可激活的传送石碑，方便在不同地点之间往返。",
  ],
  [
    "farmers-delight",
    ["farmersdelight"],
    "Farmer's Delight",
    "农夫乐事",
    "扩展烹饪、农作物与餐食，提供厨房相关工具和方块。",
  ],
  [
    "toms-storage",
    ["toms_storage"],
    "Tom's Simple Storage Mod",
    "汤姆的简易存储",
    "通过连接存储容器和终端，集中访问及管理物品。",
    ["汤姆存储"],
  ],
  [
    "ae2",
    ["ae2"],
    "Applied Energistics 2",
    "应用能源 2",
    "构建网络化存储与自动合成系统，管理大规模物品流转。",
    ["ae2", "应用能源"],
  ],
  [
    "botania",
    ["botania"],
    "Botania",
    "植物魔法",
    "围绕花朵、魔力与自然主题搭建功能装置和自动化系统。",
  ],
  [
    "mekanism",
    ["mekanism"],
    "Mekanism",
    "通用机械",
    "添加矿物处理、能源、管道和工业机械等科技内容。",
    ["mek"],
  ],
  [
    "patchouli",
    ["patchouli"],
    "Patchouli",
    "帕秋莉手册",
    "为模组和整合包提供可交互的游戏内说明书系统。",
    ["帕秋莉"],
  ],
  [
    "krypton",
    ["krypton"],
    "Krypton",
    "氪",
    "优化支持版本中的网络处理，减少部分网络开销。",
  ],
  [
    "debugify",
    ["debugify"],
    "Debugify",
    "Debugify 原版修复",
    "集中提供针对部分原版问题的修复，可按需配置。",
  ],
  [
    "spark",
    ["spark"],
    "spark",
    "Spark 性能分析器",
    "分析游戏卡顿、线程和内存等性能信息，帮助定位问题。",
    ["性能分析"],
  ],
];

// Identifiers checked against Modrinth's public /v2/projects API on 2026-10-20.
// These identify projects; the associated mod's software license is independent
// of this catalogue's original MIT-licensed Chinese summaries.
const PROJECT_IDS: Record<string, string> = {
  sodium: "AANobbMI",
  lithium: "gvQqBUqZ",
  "fabric-api": "P7dR8mSH",
  iris: "YL57xq9U",
  modmenu: "mOgUt4GM",
  create: "LNytGWDc",
  jei: "u6dRKJwZ",
  rei: "nfn13YXA",
  emi: "fRiHVvU7",
  jade: "nvQzSEkH",
  wthit: "6AQIaxuO",
  appleskin: "EsAfCjCV",
  "ferrite-core": "uXXizFIs",
  modernfix: "nmDcB62a",
  entityculling: "NNAgCjsB",
  immediatelyfast: "5ZwdcRci",
  "dynamic-fps": "LQ3K71Q1",
  indium: "Orvt0mRa",
  phosphor: "hEOCdOgW",
  starlight: "H8CaAYZC",
  "cloth-config": "9s6osm5g",
  "architectury-api": "lhGA9TYQ",
  yacl: "1eAoo2KR",
  "sodium-extra": "PtjYWJkn",
  "reeses-sodium-options": "Bh37bMuy",
  "xaeros-minimap": "1bokaNcj",
  "xaeros-world-map": "NcUtCpym",
  journeymap: "lfHFW1mp",
  "mouse-tweaks": "aC3cM3Vq",
  "inventory-profiles-next": "O7RBXm3n",
  betterf3: "8shC1gFX",
  zoomify: "w7ThoJFB",
  continuity: "1IjD5062",
  lambdynamiclights: "yBW8D80W",
  "sophisticated-backpacks": "TyCTlI4b",
  "sophisticated-core": "nmoqTijg",
  waystones: "LOpKHB2A",
  "farmers-delight": "R2OftAxM",
  "toms-storage": "XZNI4Cpy",
  botania: "pfjLUfGv",
  mekanism: "Ce6I4WUE",
  patchouli: "nU0bVIaL",
  krypton: "fQEb0iXm",
  debugify: "QwxR6Gcd",
  spark: "l6YH9Als",
  ae2: "XxWD5pD3",
  "create-fabric": "Xbc0uyRg",
};

export const BUILTIN_MOD_TRANSLATIONS: readonly ModTranslationEntry[] =
  builtinRows.map(
    ([
      slug,
      modIds,
      originalName,
      nameZh,
      descriptionZh,
      aliases,
      projectId,
    ]) => ({
      slug,
      modIds,
      originalName,
      nameZh,
      descriptionZh,
      aliases,
      projectId: projectId || PROJECT_IDS[slug],
      source: "LDFCL 中文目录（原创简介）",
      sourceUrl: `https://modrinth.com/mod/${slug}`,
      license: "MIT",
    }),
  );

function normalize(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function validatedEntry(
  value: any,
  filename: string,
): ModTranslationEntry | null {
  if (!value || typeof value !== "object") return null;
  const projectId = text(value.projectId, 80),
    slug = text(value.slug, 100);
  const modIds = Array.isArray(value.modIds)
    ? value.modIds
        .slice(0, 30)
        .map((id: unknown) => text(id, 100))
        .filter(Boolean)
    : [];
  const nameZh = text(value.nameZh, 120),
    descriptionZh = text(value.descriptionZh, 1200);
  if ((!projectId && !slug && !modIds.length) || !nameZh || !descriptionZh)
    return null;
  const sourceUrl = text(value.sourceUrl, 500);
  return {
    projectId,
    slug,
    modIds,
    originalName: text(value.originalName, 160),
    nameZh,
    descriptionZh,
    aliases: Array.isArray(value.aliases)
      ? value.aliases
          .slice(0, 20)
          .map((a: unknown) => text(a, 120))
          .filter(Boolean)
      : [],
    source: text(value.source, 160) || `本地目录 · ${filename}`,
    license: text(value.license, 80) || "用户提供",
    sourceUrl: sourceUrl.startsWith("https://") ? sourceUrl : undefined,
  };
}

export class ModTranslationCatalog {
  private loadedAt = 0;
  private entries: ModTranslationEntry[] = [...BUILTIN_MOD_TRANSLATIONS];
  private loading?: Promise<void>;
  constructor(private dataDir: string) {}

  async load(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.loadedAt && Date.now() - this.loadedAt < 3000) return;
    this.loading = this.reload();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async reload(): Promise<void> {
    const local: ModTranslationEntry[] = [];
    const dir = path.join(this.dataDir, "translations", "mods");
    let filenames: string[] = [];
    try {
      filenames = (await fs.readdir(dir))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .slice(0, 50);
    } catch {
      /* Directory is optional. */
    }
    for (const filename of filenames) {
      try {
        const full = path.join(dir, filename),
          stat = await fs.lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
          continue;
        const data = JSON.parse(await fs.readFile(full, "utf8"));
        if (data.schemaVersion !== 1 || !Array.isArray(data.entries)) continue;
        for (const item of data.entries.slice(0, 2000)) {
          const entry = validatedEntry(item, filename);
          if (entry) local.push(entry);
        }
      } catch {
        /* One malformed user file must not disable the built-in catalogue. */
      }
    }
    // Local entries have priority. Stable identifiers are required; filenames or
    // fuzzy English title matching cannot silently rename a different project.
    this.entries = [...local.reverse(), ...BUILTIN_MOD_TRANSLATIONS];
    this.loadedAt = Date.now();
  }

  localize(input: {
    projectId?: string;
    slug?: string;
    modIds?: string[];
    name?: string;
    description?: string;
  }): LocalizedModFields {
    let entry: ModTranslationEntry | undefined,
      matchedBy: "projectId" | "slug" | "modId" | undefined;
    const modIds = new Set((input.modIds || []).map(normalize));
    for (const candidate of this.entries) {
      if (input.projectId && candidate.projectId) {
        if (candidate.projectId === input.projectId) {
          entry = candidate;
          matchedBy = "projectId";
          break;
        }
        continue;
      }
      if (
        input.slug &&
        candidate.slug &&
        normalize(candidate.slug) === normalize(input.slug)
      ) {
        entry = candidate;
        matchedBy = "slug";
        break;
      }
      if (candidate.modIds?.some((id) => modIds.has(normalize(id)))) {
        entry = candidate;
        matchedBy = "modId";
        break;
      }
    }
    const originalName =
      input.name ||
      entry?.originalName ||
      input.slug ||
      input.modIds?.[0] ||
      "未知模组";
    const originalDescription = input.description || "";
    if (!entry)
      return {
        displayName: originalName,
        displayDescription: originalDescription,
        originalName,
        originalDescription,
        translation: {
          status: "unavailable",
          source: "原项目元数据",
          notice: "暂无中文，显示原文",
        },
      };
    return {
      displayName: entry.nameZh,
      displayDescription: entry.descriptionZh,
      originalName,
      originalDescription,
      nameZh: entry.nameZh,
      descriptionZh: entry.descriptionZh,
      translation: {
        status: "translated",
        source: entry.source || "本地中文目录",
        license: entry.license,
        sourceUrl: entry.sourceUrl,
        matchedBy,
        notice: "中文简介；原名保留供搜索与识别",
      },
    };
  }

  resolveSearch(query: string): {
    originalQuery: string;
    effectiveQuery: string;
    translated: boolean;
  } {
    const cleaned = query.trim().slice(0, 160),
      normalized = normalize(cleaned);
    const entry = this.entries.find((e) =>
      [e.nameZh, ...(e.aliases || [])].some(
        (alias) => normalize(alias) === normalized,
      ),
    );
    const effectiveQuery = entry?.slug || entry?.originalName || cleaned;
    return {
      originalQuery: cleaned,
      effectiveQuery,
      translated: effectiveQuery !== cleaned,
    };
  }
}
