import { createCommandRouter } from "./commands";
import { createLauncherRuntime, type LauncherCoreOptions } from "./runtime";
export type { LauncherCoreOptions } from "./runtime";
export interface LauncherCore {
  call(method: string, payload?: any): Promise<any>;
  state(): Promise<any>;
  dispose(): void;
}
/** Stable host API; feature handlers share the original transactional runtime. */
export async function createLauncherCore(
  options: LauncherCoreOptions,
): Promise<LauncherCore> {
  const runtime = await createLauncherRuntime(options);
  const commands = createCommandRouter(runtime);
  return {
    async call(method, payload = {}) {
      const handler = commands.get(method);
      if (!handler) throw Error("不支持的操作");
      await runtime.guardCommand(method, payload);
      return handler(payload);
    },
    state: runtime.state,
    dispose: runtime.dispose,
  };
}
