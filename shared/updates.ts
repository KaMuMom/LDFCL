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
}
