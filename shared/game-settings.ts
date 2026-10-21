import type { Instance, Settings } from "./types";

export const GAME_OPTION_DEFAULTS: Instance["gameSettings"] = {
  renderDistance: 12,
  simulationDistance: 8,
  maxFps: 120,
  fov: 0,
  gamma: 0.5,
  guiScale: 0,
  graphicsMode: 1,
  ao: true,
  enableVsync: true,
  fullscreen: false,
  soundCategory_master: 1,
  lang: "zh_cn",
  autoJump: false,
  bobView: true,
};
const ranges: Record<string, [number, number, boolean?]> = {
  renderDistance: [2, 32, true],
  simulationDistance: [2, 32, true],
  maxFps: [10, 260, true],
  fov: [-1, 1],
  gamma: [0, 1],
  guiScale: [0, 6, true],
  graphicsMode: [0, 2, true],
  soundCategory_master: [0, 1],
};

export function validateGameOptions(value: unknown): Instance["gameSettings"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("游戏设置格式无效");
  const result: Instance["gameSettings"] = {};
  for (const [key, input] of Object.entries(value)) {
    if (!Object.hasOwn(GAME_OPTION_DEFAULTS, key)) continue;
    const range = ranges[key];
    if (range) {
      if (
        typeof input !== "number" ||
        !Number.isFinite(input) ||
        input < range[0] ||
        input > range[1] ||
        (range[2] && !Number.isInteger(input))
      )
        throw new Error(`${key} 超出允许范围`);
      result[key] = input;
    } else if (key === "lang") {
      if (
        typeof input !== "string" ||
        !/^[a-z]{2,3}_[a-z0-9]{2,8}$/i.test(input)
      )
        throw new Error("游戏语言代码无效");
      result[key] = input.toLowerCase();
    } else {
      if (typeof input !== "boolean") throw new Error(`${key} 必须为开关值`);
      result[key] = input;
    }
  }
  return result;
}

export function effectiveGameOptions(
  settings: Pick<Settings, "gameDefaults">,
  instance: Pick<Instance, "gameSettings">,
): Instance["gameSettings"] {
  return { ...(settings.gameDefaults || {}), ...(instance.gameSettings || {}) };
}
