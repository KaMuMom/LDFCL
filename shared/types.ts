export interface GameDirectory {
  id: string;
  name: string;
  path: string;
  layout: "standard" | "legacy";
  isDefault?: boolean;
}
export interface Instance {
  id: string;
  name: string;
  version: string;
  loader: "vanilla" | "fabric" | "quilt" | "forge" | "optifine";
  loaderVersion?: string;
  gameDirectoryId?: string;
  importedVersionId?: string;
  versionDirectory?: string;
  createdAt: string;
  lastPlayed?: string;
  javaPath?: string;
  memoryMb?: number;
  gameSettings: Record<string, string | number | boolean>;
}
export interface Account {
  id: string;
  type: "microsoft" | "offline" | "yggdrasil";
  name: string;
  uuid: string;
  accessToken?: string;
  refreshToken?: string;
  server?: string;
  clientToken?: string;
  expiresAt?: number;
  skins?: any[];
  capes?: any[];
}
export interface Settings {
  downloadConcurrency: number;
  memoryMode: "auto" | "manual";
  memoryMb: number;
  javaPath: string;
  microsoftClientId: string;
  closeOnLaunch: boolean;
  gameDefaults?: Record<string, string | number | boolean>;
  gameRoot?: string;
}
export interface FavoriteMod {
  projectId: string;
  slug: string;
  title: string;
  displayName?: string;
  description?: string;
  iconUrl?: string;
  author?: string;
}
export interface SkinLibraryEntry {
  id: string;
  name: string;
  variant: "classic" | "slim";
  createdAt: string;
  updatedAt: string;
  dataUrl: string;
}
export interface Task {
  id: string;
  title: string;
  progress: number;
  status: string;
  detail?: string;
}
export interface ModpackVersion {
  id: string;
  name: string;
  versionNumber: string;
  versionType: "release" | "beta" | "alpha";
  publishedAt: string;
  gameVersions: string[];
  loaders: string[];
  downloadSize: number;
}
export interface OptifineVersion {
  id: string;
  minecraftVersion: string;
  type: string;
  patch: string;
  filename: string;
  preview: boolean;
}
export interface State {
  gameDirectories: GameDirectory[];
  selectedGameDirectoryId?: string;
  instances: Instance[];
  accounts: Account[];
  settings: Settings;
  selectedInstanceId?: string;
  selectedAccountId?: string;
  system: {
    totalMemoryMb: number;
    freeMemoryMb: number;
    platform: string;
    version: string;
    dataDir: string;
    gameRoot: string;
    defaultGameRoot: string;
    gameDirectoryError?: string;
  };
}
export interface LauncherAPI {
  call<T = any>(method: string, payload?: any): Promise<T>;
  onEvent(callback: (event: any) => void): () => void;
  window(action: "minimize" | "maximize" | "close"): void;
}
