import { resolveLauncherDataDirectory } from "@ldfcl/core/application-paths";
import { resolveDefaultGameDirectoryPath } from "@ldfcl/core/game-directories";
import path from "node:path";

export function cliDirectories(options: {
  programDir?: string;
  dataDir?: string;
  gameRoot?: string;
}) {
  const dataDirOverride = options.dataDir || process.env.LDFCL_DATA_DIR;
  const gameRootOverride = options.gameRoot || process.env.LDFCL_GAME_ROOT;
  const input = {
    isPackaged: false,
    execPath: process.execPath,
    appPath:
      options.programDir ||
      path.dirname(require.resolve("@ldfcl/cli/package.json")),
    dataDirOverride: dataDirOverride
      ? path.resolve(dataDirOverride)
      : undefined,
    gameRootOverride: gameRootOverride
      ? path.resolve(gameRootOverride)
      : undefined,
  };
  return {
    dataDir: resolveLauncherDataDirectory(input),
    defaultGameRoot: resolveDefaultGameDirectoryPath(input),
    programDir: input.appPath,
  };
}
