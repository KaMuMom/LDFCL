import type { LauncherRuntime } from "../runtime";
import {
  controlDownload,
  getDownloadTaskFiles,
  setTaskDownloadSource,
} from "../services/downloads";
import type { CommandHandlers } from "./registry";
export function downloadsCommands(ctx: LauncherRuntime): CommandHandlers {
  return {
    "download:files": async (p: any = {}) => {
      return getDownloadTaskFiles(p.id, p.offset, p.limit);
    },
    "download:control": async (p: any = {}) => {
      controlDownload(p.id, p.action);
      return true;
    },
    "download:source": async (p: any = {}) => {
      setTaskDownloadSource(p.id, p.source);
      return true;
    },
  };
}
