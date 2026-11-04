export interface LauncherUpdateAttempt {
  id: string;
  status: "installed" | "failed" | "rolled-back";
  version: string;
  completedAt: string;
  message: string;
  logPath?: string;
}

export interface LauncherUpdateState {
  status:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  currentVersion: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  releaseUrl: string;
  supported: boolean;
  checkedAt?: string;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
  lastAttempt?: LauncherUpdateAttempt;
}
