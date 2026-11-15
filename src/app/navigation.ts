import {
  Home,
  Layers,
  Compass,
  Download,
  Users,
  Shirt,
  Activity,
  Settings,
  Info,
  Palette,
  SlidersHorizontal,
  Cpu,
  FolderOpen,
  HardDrive,
  RefreshCw,
} from "lucide-react";

export const NAVIGATION = [
  {
    id: "home",
    name: "开始游戏",
    icon: Home,
    group: "游戏",
    description: "选择身份和版本，进入你的世界",
  },
  {
    id: "instances",
    name: "游戏实例",
    icon: Layers,
    group: "游戏",
    description: "版本、模组、存档和游戏设置",
  },
  {
    id: "discover",
    name: "资源下载",
    icon: Compass,
    group: "资源",
    description: "安装 Minecraft，发现社区内容",
  },
  {
    id: "downloads",
    name: "下载任务",
    icon: Download,
    group: "资源",
    description: "进度、暂停、继续与文件详情",
  },
  {
    id: "accounts",
    name: "账号管理",
    icon: Users,
    group: "个人",
    description: "正版、离线和皮肤站身份",
  },
  {
    id: "wardrobe",
    name: "皮肤与披风",
    icon: Shirt,
    group: "个人",
    description: "角色预览、编辑器和保存的皮肤",
  },
  {
    id: "logs",
    name: "运行日志",
    icon: Activity,
    group: "工具",
    description: "游戏日志与崩溃诊断",
  },
  {
    id: "settings",
    name: "启动器设置",
    icon: Settings,
    group: "工具",
    description: "外观、性能、目录与更新",
  },
  {
    id: "about",
    name: "关于与致谢",
    icon: Info,
    group: "工具",
    description: "版本信息、开源项目与贡献者",
  },
] as const;
export type PageId = (typeof NAVIGATION)[number]["id"];

export const SETTINGS_SECTIONS = [
  {
    id: "appearance",
    name: "外观与动效",
    icon: Palette,
    description: "主题、材质和动态效果",
  },
  {
    id: "game",
    name: "游戏默认项",
    icon: SlidersHorizontal,
    description: "所有实例的默认游戏偏好",
  },
  {
    id: "runtime",
    name: "Java 与内存",
    icon: Cpu,
    description: "启动环境与内存分配",
  },
  {
    id: "network",
    name: "下载与网络",
    icon: Download,
    description: "下载来源与并发线程",
  },
  {
    id: "directories",
    name: "游戏目录",
    icon: FolderOpen,
    description: "切换或添加游戏文件夹",
  },
  {
    id: "storage",
    name: "数据与存储",
    icon: HardDrive,
    description: "本地配置和内容存储",
  },
  {
    id: "updates",
    name: "检查更新",
    icon: RefreshCw,
    description: "应用版本与更新记录",
  },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export interface Destination {
  page: PageId;
  settingsSection?: SettingsSection;
  instanceTab?: string;
  resource?: "minecraft" | "mod" | "modpack" | "resourcepack" | "shader";
}
export const QUICK_DESTINATIONS: {
  title: string;
  detail: string;
  destination: Destination;
  keywords?: string;
}[] = [
  ...NAVIGATION.map((item) => ({
    title: item.name,
    detail: item.description,
    destination: { page: item.id },
  })),
  ...SETTINGS_SECTIONS.map((item) => ({
    title: item.name,
    detail: "启动器设置 / " + item.description,
    destination: { page: "settings" as const, settingsSection: item.id },
  })),
  {
    title: "Mod 管理",
    detail: "当前实例 / 启停、更新与重复检测",
    destination: { page: "instances", instanceTab: "mods" },
    keywords: "模组 前置",
  },
  {
    title: "游戏预设",
    detail: "当前实例 / 画面、声音与语言",
    destination: { page: "instances", instanceTab: "game" },
  },
  {
    title: "健康与快照",
    detail: "当前实例 / 检查、修复、备份与回滚",
    destination: { page: "instances", instanceTab: "health" },
  },
  {
    title: "资源与光影",
    detail: "当前实例 / 资源包排序与光影选择",
    destination: { page: "instances", instanceTab: "packs" },
  },
  {
    title: "下载 Minecraft",
    detail: "资源下载 / 版本与加载器",
    destination: { page: "discover", resource: "minecraft" },
    keywords: "Fabric Forge NeoForge OptiFine Quilt",
  },
  {
    title: "下载 Mod",
    detail: "资源下载 / 中文模组与收藏",
    destination: { page: "discover", resource: "mod" },
  },
  {
    title: "下载整合包",
    detail: "资源下载 / 选择整合包版本",
    destination: { page: "discover", resource: "modpack" },
  },
];
