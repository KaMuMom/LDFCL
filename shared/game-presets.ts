import type { Instance } from "./types";
import { GAME_OPTION_DEFAULTS } from "./game-settings";

export const GAME_PRESETS: Record<
  string,
  { name: string; description: string; options: Instance["gameSettings"] }
> = {
  performance: {
    name: "流畅",
    description: "降低渲染距离与画质，优先帧率",
    options: {
      ...GAME_OPTION_DEFAULTS,
      renderDistance: 6,
      simulationDistance: 5,
      graphicsMode: 0,
      ao: false,
      maxFps: 120,
      enableVsync: false,
    },
  },
  balanced: {
    name: "均衡",
    description: "兼顾画质和帧率",
    options: { ...GAME_OPTION_DEFAULTS },
  },
  quality: {
    name: "画质",
    description: "提高视距与画面质量",
    options: {
      ...GAME_OPTION_DEFAULTS,
      renderDistance: 20,
      simulationDistance: 12,
      graphicsMode: 2,
      ao: true,
      maxFps: 120,
    },
  },
  cinematic: {
    name: "电影",
    description: "高视距与稳定帧率，适合截图录制",
    options: {
      ...GAME_OPTION_DEFAULTS,
      renderDistance: 28,
      simulationDistance: 12,
      graphicsMode: 2,
      ao: true,
      maxFps: 60,
      bobView: false,
      guiScale: 2,
    },
  },
};
export function gamePreset(id: string): Instance["gameSettings"] {
  const preset = GAME_PRESETS[id];
  if (!preset) throw new Error("未知的游戏设置预设");
  return { ...preset.options };
}
