export interface GameDirectory {
  id: string;
  name: string;
  path: string;
  layout: "standard" | "legacy";
  isDefault?: boolean;
  available?: boolean;
  unavailableReason?: string;
}
export interface Instance {
  id: string;
  name: string;
  version: string;
  loader: "vanilla" | "fabric" | "quilt" | "forge" | "neoforge" | "optifine";
  loaderVersion?: string;
  gameDirectoryId?: string;
  importedVersionId?: string;
  versionDirectory?: string;
  createdAt: string;
  lastPlayed?: string;
  javaPath?: string;
  jvmArgs?: string[];
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
export type MicrosoftClientIdStorageStatus =
  "ready" | "empty" | "migration-pending" | "unavailable" | "unreadable";
export interface Settings {
  downloadConcurrency: number;
  memoryMode: "auto" | "manual";
  memoryMb: number;
  javaPath: string;
  jvmArgs?: string[];
  microsoftClientId: string;
  microsoftClientIdConfigured?: boolean;
  microsoftClientIdStorageStatus?: MicrosoftClientIdStorageStatus;
  closeOnLaunch: boolean;
  gameDefaults?: Record<string, string | number | boolean>;
  gameRoot?: string;
  downloadSource?: "official" | "bmclapi";
  theme?: "light" | "dark" | "system";
  interfacePerformance?: "efficient" | "quality";
  gamePreset?: "custom" | "performance" | "balanced" | "quality" | "cinematic";
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
export interface DownloadContext {
  resourceName?: string;
  targetInstanceId?: string;
  targetInstanceName?: string;
  planId?: string;
  stageId?: string;
  planFileId?: string;
}
export interface DownloadFileProgress {
  id: string;
  name: string;
  status: "queued" | "downloading" | "completed" | "failed" | "cancelled";
  receivedBytes: number;
  totalBytes?: number;
}
export interface DownloadFilePage {
  taskId: string;
  offset: number;
  total: number;
  files: DownloadFileProgress[];
}
export interface DownloadPlanStage {
  id: string;
  title: string;
  status:
    "pending" | "resolving" | "running" | "completed" | "error" | "cancelled";
  totalFiles?: number;
  completedFiles?: number;
  fileListId?: string;
}
export interface DownloadTaskProgress extends DownloadContext {
  kind: "plan" | "files";
  progressMode: "bytes" | "files" | "indeterminate";
  phase?: "queued" | "resolving" | "downloading" | "verifying";
  totalFiles?: number;
  completedFiles?: number;
  receivedBytes?: number;
  totalBytes?: number;
  activeFiles?: DownloadFileProgress[];
  stages?: DownloadPlanStage[];
}
export interface Task {
  id: string;
  title: string;
  progress: number;
  status: string;
  detail?: string;
  controllable?: boolean;
  source?: "official" | "bmclapi";
  download?: DownloadTaskProgress;
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
  runningInstanceIds?: string[];
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
    gameDirectoryWarnings?: string[];
  };
}
export interface LauncherAPI {
  call<T = any>(method: string, payload?: any): Promise<T>;
  onEvent(callback: (event: any) => void): () => void;
  window(action: "minimize" | "maximize" | "close"): void;
}
