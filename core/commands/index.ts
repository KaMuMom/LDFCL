import type { LauncherRuntime } from "../runtime";
import { accountsCommands } from "./accounts";
import { appearanceCommands } from "./appearance";
import { contentCommands } from "./content";
import { directoriesCommands } from "./directories";
import { downloadsCommands } from "./downloads";
import { gameCommands } from "./game";
import { commandRegistry } from "./registry";
import { storageCommands } from "./storage";
import { systemCommands } from "./system";
export const createCommandRouter = (runtime: LauncherRuntime) =>
  commandRegistry([
    downloadsCommands(runtime),
    systemCommands(runtime),
    storageCommands(runtime),
    directoriesCommands(runtime),
    gameCommands(runtime),
    accountsCommands(runtime),
    appearanceCommands(runtime),
    contentCommands(runtime),
  ]);
