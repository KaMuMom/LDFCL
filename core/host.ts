/** Native capabilities supplied by a desktop host, with no Electron types. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
  properties: (
    "openDirectory" | "createDirectory" | "openFile" | "multiSelections"
  )[];
}

export interface SaveFileOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface LauncherHost {
  chooseFiles(options: OpenFileOptions): Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
  chooseSaveFile(options: SaveFileOptions): Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  /** Synchronous so a cancelled flow cannot copy a code after yielding. */
  writeClipboardText?(text: string): void;
  trashItem(path: string): Promise<void>;
  imageDataUrl(path: string): string;
  focusWindow(): void;
  minimizeWindow(): void;
}
