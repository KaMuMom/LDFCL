import fs from "node:fs/promises";
import path from "node:path";
import { Store } from "@ldfcl/core/store";
import { JavaManager } from "@ldfcl/core/services/java";
import {
  gameDirectoryPathKey,
  gameDirectoryRoots,
  resolveDefaultGameDirectoryPath,
  safeGameVersionId,
} from "@ldfcl/core/game-directories";
import { instanceGameDirectory } from "@ldfcl/core/instance-paths";
import { resolveLauncherDataDirectory } from "@ldfcl/core/application-paths";
import { LAUNCHER_VERSION } from "../shared/launcher";
import type { GameDirectory, Instance } from "../shared/types";

type Options = {
  json: boolean;
  help: boolean;
  version: boolean;
  dataDir?: string;
  gameRoot?: string;
  programDir?: string;
  file?: string;
  output?: string;
  bundle?: string;
  name?: string;
  snapshot?: string;
  auto?: boolean;
  apply?: boolean;
  command: string[];
};

const HELP = `LDFCL CLI ${LAUNCHER_VERSION}

Usage:
  ldfcl-cli instance list [options]
  ldfcl-cli java list [options]
  ldfcl-cli instance manifest <instance-id> [--output <file> | --bundle <folder>]
  ldfcl-cli instance rebuild (--file <manifest> | --bundle <folder>)
  ldfcl-cli instance diff <before.json> <after.json>
  ldfcl-cli store stats
  ldfcl-cli snapshot (create|list|diff|restore) <instance-id> [--snapshot <id>] [--apply]
  ldfcl-cli health (scan|fix) <instance-id> [--auto]
  ldfcl-cli diagnose <instance-id> [--file <report>]

Commands:
  instance list        List registered instances without scanning or migration
  java list            Discover installed Java; never downloads a runtime

Options:
  --json               Print structured JSON (errors go to stderr)
  --data-dir <path>    Launcher configuration directory
  --game-root <path>   Filter instances / discover Java in this Minecraft root
  --program-dir <path> Directory containing the launcher (default: CLI package)
  -h, --help           Show help
  -v, --version        Show version

Defaults: <program-dir>/LDFCL-data and <program-dir>/.minecraft.
LDFCL_DATA_DIR / LDFCL_GAME_ROOT are supported; command options take precedence.
With --data-dir only, the default game root is <data-dir>/.minecraft.
Both list commands are read-only; Java discovery executes local Java probes.
Advanced commands use the same core. Snapshot restore previews unless --apply.
`;

class CliError extends Error {
  constructor(
    message: string,
    readonly code = "INVALID_ARGUMENTS",
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

function parse(args: string[]): Options {
  const options: Options = {
    json: false,
    help: false,
    version: false,
    command: [],
  };
  const seen = new Set<string>();
  const paths: Record<
    string,
    "dataDir" | "gameRoot" | "programDir" | "file" | "output" | "bundle"
  > = {
    "--data-dir": "dataDir",
    "--game-root": "gameRoot",
    "--program-dir": "programDir",
    "--file": "file",
    "--output": "output",
    "--bundle": "bundle",
  };
  const values: Record<
    string,
    "name" | "snapshot"
  > = {
    "--name": "name",
    "--snapshot": "snapshot",
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (["--auto", "--apply"].includes(argument)) {
      options[argument.slice(2) as "auto" | "apply"] = true;
      continue;
    }
    if (["--json", "--help", "-h", "--version", "-v"].includes(argument)) {
      if (argument === "--json") options.json = true;
      else if (["--help", "-h"].includes(argument)) options.help = true;
      else options.version = true;
      continue;
    }
    if (argument.startsWith("-")) {
      const equals = argument.indexOf("=");
      const flag = equals < 0 ? argument : argument.slice(0, equals);
      const valueKey = values[flag];
      if (valueKey) {
        if (seen.has(valueKey)) throw new CliError(`Duplicate option: ${flag}`);
        seen.add(valueKey);
        const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
        if (!value || value.startsWith("--") || value.includes("\0"))
          throw new CliError(`Missing or invalid value for ${flag}`);
        options[valueKey] = value;
        continue;
      }
      const key = paths[flag];
      if (!key) throw new CliError(`Unknown option: ${flag}`);
      if (seen.has(key)) throw new CliError(`Duplicate option: ${flag}`);
      seen.add(key);
      const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
      if (!value || value.startsWith("--") || value.includes("\0"))
        throw new CliError(`Missing or invalid path for ${flag}`);
      options[key] = path.resolve(value);
      continue;
    }
    options.command.push(argument);
  }
  return options;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function printable(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

async function load(options: Options): Promise<{
  store: Store;
  dataDir: string;
  defaultGameRoot: string;
}> {
  const programDir = options.programDir || path.resolve(__dirname, "..", "..");
  const dataDirOverride = options.dataDir || process.env.LDFCL_DATA_DIR;
  const gameRootOverride = options.gameRoot || process.env.LDFCL_GAME_ROOT;
  const paths = {
    isPackaged: false,
    execPath: process.execPath,
    appPath: programDir,
    ...(dataDirOverride
      ? { dataDirOverride: path.resolve(dataDirOverride) }
      : {}),
    ...(gameRootOverride
      ? { gameRootOverride: path.resolve(gameRootOverride) }
      : {}),
  };
  const dataDir = resolveLauncherDataDirectory(paths);
  const defaultGameRoot = resolveDefaultGameDirectoryPath(paths);
  const store = new Store(dataDir, { defaultGameRoot, legacyDataDir: dataDir });
  await store.load({ readOnly: true });
  return { store, dataDir, defaultGameRoot };
}

async function instanceRecord(
  instance: Instance,
  directory: GameDirectory,
  selected: boolean,
) {
  const roots = gameDirectoryRoots(directory);
  let gameDirectory = instanceGameDirectory(roots.minecraftRoot, instance);
  let pendingMigration = false;
  // Report an existing old instance where it currently lives. List never calls
  // prepareInstanceDirectories, reserves a folder, or edits a migration marker.
  if (!instance.versionDirectory) {
    const legacy = path.join(
      roots.dataDir,
      "instances",
      safeGameVersionId(instance.id),
    );
    const stat = await fs
      .lstat(legacy)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      gameDirectory = legacy;
      pendingMigration = true;
    }
  }
  return {
    id: text(instance.id),
    name: text(instance.name),
    version: text(instance.version),
    loader: text(instance.loader),
    ...(instance.loaderVersion
      ? { loaderVersion: text(instance.loaderVersion) }
      : {}),
    gameDirectoryId: directory.id,
    gameRoot: roots.minecraftRoot,
    directory: gameDirectory,
    selected,
    pendingMigration,
  };
}

export async function runCli(
  args: string[] = process.argv.slice(2),
): Promise<number> {
  const wantsJson = args.includes("--json");
  try {
    const options = parse(args);
    if (options.version) {
      process.stdout.write(
        options.json
          ? JSON.stringify({ version: LAUNCHER_VERSION }) + "\n"
          : LAUNCHER_VERSION + "\n",
      );
      return 0;
    }
    if (
      options.help ||
      !options.command.length ||
      options.command[0] === "help"
    ) {
      process.stdout.write(
        options.json
          ? JSON.stringify({ version: LAUNCHER_VERSION, help: HELP }) + "\n"
          : HELP,
      );
      return 0;
    }
    const command = options.command.join(" ");
    if (!["instance list", "java list"].includes(command)) {
      const prefix = options.command.slice(0, 2).join(" ");
      if (
        options.command[0] !== "diagnose" &&
        ![
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
        ].includes(prefix)
      )
        throw new CliError(
          `Unknown command: ${command}. Use --help for usage.`,
        );
      const { runAdvanced } =
        require("./commands") as typeof import("./commands");
      const result = await runAdvanced(options);
      if (!result.handled)
        throw new CliError(
          `Unknown command: ${command}. Use --help for usage.`,
        );
      process.stdout.write(
        JSON.stringify(result.value, null, options.json ? 2 : 2) + "\n",
      );
      return 0;
    }
    const { store, dataDir } = await load(options);
    const override = options.gameRoot || process.env.LDFCL_GAME_ROOT;
    if (command === "instance list") {
      const key = override
        ? gameDirectoryPathKey(path.resolve(override))
        : undefined;
      const gameDirectories = store.gameDirectories.filter(
        (directory) =>
          !key ||
          gameDirectoryPathKey(gameDirectoryRoots(directory).minecraftRoot) ===
            key,
      );
      const instances = [];
      for (const directory of gameDirectories) {
        for (const instance of store.instances.filter(
          (item) => item.gameDirectoryId === directory.id,
        )) {
          instances.push(
            await instanceRecord(
              instance,
              directory,
              store.selectedGameDirectoryId === directory.id &&
                store.selectedInstanceId === instance.id,
            ),
          );
        }
      }
      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            { command, dataDir, gameDirectories, instances },
            null,
            2,
          ) + "\n",
        );
      } else {
        process.stdout.write("ID\tNAME\tMINECRAFT\tLOADER\tDIRECTORY\n");
        for (const instance of instances)
          process.stdout.write(
            [
              instance.id,
              instance.name,
              instance.version,
              instance.loader,
              instance.directory,
            ]
              .map(printable)
              .join("\t") + "\n",
          );
        if (!instances.length)
          process.stdout.write("No registered instances.\n");
      }
      return 0;
    }
    const roots = gameDirectoryRoots(store.currentGameDirectory);
    const runtimeDataDir = override ? path.resolve(override) : roots.dataDir;
    const java = (await new JavaManager(runtimeDataDir).discover())
      .map((item) => ({
        path: item.path,
        major: item.major,
        version: item.version,
        ...(item.architecture ? { architecture: item.architecture } : {}),
        ...(item.home ? { home: item.home } : {}),
      }))
      .sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            command,
            dataDir,
            gameRoot: override ? path.resolve(override) : roots.minecraftRoot,
            runtimeDataDir,
            java,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write("MAJOR\tVERSION\tARCHITECTURE\tPATH\n");
      for (const item of java)
        process.stdout.write(
          [item.major, item.version, item.architecture, item.path]
            .map(printable)
            .join("\t") + "\n",
        );
      if (!java.length) process.stdout.write("No installed Java found.\n");
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CliError ? error.code : "LIST_FAILED";
    process.stderr.write(
      wantsJson
        ? JSON.stringify({ error: { code, message } }) + "\n"
        : `LDFCL CLI: ${printable(message)}\n`,
    );
    return error instanceof CliError ? error.exitCode : 1;
  }
}

if (require.main === module) {
  void runCli().then((code) => {
    process.exitCode = code;
  });
}
