import { CORE_COMMANDS, type CoreCommand } from "@ldfcl/contracts/commands";
export type CommandHandler = (payload?: any) => Promise<any>;
export type CommandHandlers = Partial<Record<CoreCommand, CommandHandler>>;
export function commandRegistry(
  groups: CommandHandlers[],
): ReadonlyMap<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();
  for (const group of groups)
    for (const [name, handler] of Object.entries(group)) {
      if (
        !handler ||
        handlers.has(name) ||
        !(CORE_COMMANDS as readonly string[]).includes(name)
      )
        throw Error("Invalid or duplicate launcher command: " + name);
      handlers.set(name, handler);
    }
  for (const name of CORE_COMMANDS)
    if (!handlers.has(name)) throw Error("Missing launcher command: " + name);
  return handlers;
}
