import type { Instance } from "./types";

export interface StoredFile {
  path: string;
  sha256: string;
  size: number;
  mutable: boolean;
  role: "mod" | "resourcepack" | "shaderpack" | "client" | "library" | "data";
  materialization?: "hardlink" | "copy";
  fallbackReason?: string;
}
export interface InstanceManifest {
  schemaVersion: 1;
  kind: "ldfcl-instance-manifest";
  id: string;
  createdAt: string;
  directoryName: string;
  instance?: Instance;
  files: StoredFile[];
  directories: string[];
  sharedFiles: StoredFile[];
  versionRecipe: {
    versionId: string;
    profiles: { id: string; metadata: Record<string, any> }[];
    sharedRoots: string[];
    completeOnLaunch: boolean;
  };
  excludedPaths: string[];
}
export interface StorageDiff {
  added: StoredFile[];
  removed: StoredFile[];
  changed: { before: StoredFile; after: StoredFile }[];
  unchanged: number;
}
export interface InstanceSnapshot {
  schemaVersion: 1;
  kind: "ldfcl-instance-snapshot";
  id: string;
  name: string;
  createdAt: string;
  files: StoredFile[];
  directories: string[];
  scopes: string[];
  logicalBytes: number;
}
export interface SnapshotPreview {
  snapshotId: string;
  previewId: string;
  diff: StorageDiff;
  preservedPaths: string[];
}
export interface StorageStats {
  objects: number;
  storedBytes: number;
  logicalBytes: number;
  referencedFiles: number;
  deduplicatedBytes: number;
  manifests: number;
  hardlinkedFiles: number;
  copiedFiles: number;
}
