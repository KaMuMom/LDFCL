import path from "node:path";
import fs from "node:fs/promises";
import { createLauncherCore } from "@ldfcl/core/launcher";
import { resolveLauncherDataDirectory } from "@ldfcl/core/application-paths";
import { resolveDefaultGameDirectoryPath } from "@ldfcl/core/game-directories";
import { AI_DISABLED_MESSAGE } from "../shared/ai";

interface AdvancedOptions {
  command: string[];
  json: boolean;
  programDir?: string;
  dataDir?: string;
  gameRoot?: string;
  file?: string;
  output?: string;
  bundle?: string;
  name?: string;
  snapshot?: string;
  prompt?: string;
  provider?: string;
  baseUrl?: string;
  model?: string;
  auto?: boolean;
  apply?: boolean;
  consent?: boolean;
}
async function jsonFile(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
    throw Error("Manifest must be an ordinary JSON file smaller than 32 MiB");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw Error("Invalid manifest JSON");
  }
}
export async function runAdvanced(
  options: AdvancedOptions,
): Promise<{ handled: boolean; value?: unknown }> {
  const [group, action, id] = options.command;
  const recognized =
    group === "diagnose" ||
    [
      "instance manifest",
      "instance rebuild",
      "instance diff",
      "store stats",
      "snapshot create",
      "snapshot list",
      "snapshot diff",
      "snapshot restore",
      "health scan",
      "health fix",
      "ai diagnose",
      "ai configure",
      "ai settings",
    ].includes(`${group} ${action}`);
  if (!recognized) return { handled: false };
  // Reject before creating the core or reading any AI settings or key.
  if (group === "ai") throw Error(AI_DISABLED_MESSAGE);
  if (group === "instance" && action === "diff") {
    if (!id || !options.command[3])
      throw Error("instance diff needs two manifest files");
    const {
      InstanceStorageService,
    } = require("@ldfcl/core/services/instance-manifest");
    return {
      handled: true,
      value: new InstanceStorageService({
        dataDir: options.dataDir || process.cwd(),
      }).diff(
        await jsonFile(path.resolve(id)),
        await jsonFile(path.resolve(options.command[3])),
      ),
    };
  }
  const programDir = options.programDir || path.resolve(__dirname, "..", "..");
  const paths = {
    isPackaged: false,
    execPath: process.execPath,
    appPath: programDir,
    dataDirOverride: options.dataDir || process.env.LDFCL_DATA_DIR,
    gameRootOverride: options.gameRoot || process.env.LDFCL_GAME_ROOT,
  };
  const core = await createLauncherCore({
    dataDir: resolveLauncherDataDirectory(paths),
    defaultGameRoot: resolveDefaultGameDirectoryPath(paths),
    host: {
      chooseFiles: async () => ({ canceled: true, filePaths: [] }),
      chooseSaveFile: async () => ({ canceled: true }),
      openExternal: async () => {
        throw Error("Use the desktop launcher to open a browser");
      },
      openPath: async () => "Use the desktop launcher to open folders",
      trashItem: async () => {
        throw Error("Use the desktop launcher to recycle instances");
      },
      imageDataUrl: () => {
        throw Error("Native images require the desktop launcher");
      },
      focusWindow: () => {},
      minimizeWindow: () => {},
    },
  });
  try {
    if (options.gameRoot || process.env.LDFCL_GAME_ROOT)
      await core.call("game-directory:add", {
        path: path.resolve(options.gameRoot || process.env.LDFCL_GAME_ROOT!),
      });
    let value: unknown;
    if (group === "instance" && action === "manifest") {
      if (!id) throw Error("instance manifest needs an instance ID");
      value = await core.call("instance:manifest", {
        id,
        output: options.output,
        bundle: options.bundle,
        cli: true,
      });
    } else if (group === "instance" && action === "rebuild") {
      if (!options.file && !options.bundle)
        throw Error("instance rebuild needs --file or --bundle");
      value = await core.call("instance:rebuild", {
        file: options.file,
        bundle: options.bundle,
        name: options.name,
      });
    } else if (group === "store") value = await core.call("store:stats");
    else if (group === "snapshot") {
      if (!id) throw Error("snapshot commands need an instance ID");
      if (["diff", "restore"].includes(action) && !options.snapshot)
        throw Error("Use --snapshot <snapshot-id>");
      if (action === "restore" && !options.apply)
        value = await core.call("snapshot:preview", {
          id,
          snapshotId: options.snapshot,
        });
      else
        value = await core.call(`snapshot:${action}`, {
          id,
          snapshotId: options.snapshot,
          name: options.name,
          apply: options.apply,
        });
    } else if (group === "health") {
      if (!id) throw Error("health commands need an instance ID");
      if (action === "fix" && !options.auto)
        throw Error("health fix requires --auto; use health scan to preview");
      value = await core.call(`health:${action}`, { id, auto: options.auto });
    } else if (group === "diagnose") {
      if (!action) throw Error("diagnose needs an instance ID");
      value = await core.call(
        options.file ? "diagnosis:import" : "diagnosis:list",
        { id: action, file: options.file },
      );
    }
    return { handled: true, value };
  } finally {
    core.dispose();
  }
}
