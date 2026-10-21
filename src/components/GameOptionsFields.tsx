import type { Instance } from "../../shared/types";
import { GAME_OPTION_DEFAULTS } from "../../shared/game-settings";
import "./game-options.css";

type Props = {
  value: Instance["gameSettings"];
  onChange: (key: string, value: string | number | boolean) => void;
  idPrefix: string;
};

export default function GameOptionsFields({
  value,
  onChange,
  idPrefix,
}: Props) {
  const options = { ...GAME_OPTION_DEFAULTS, ...value };
  const sliders: [string, string, number, number, number, string][] = [
    ["renderDistance", "渲染距离", 2, 32, 1, "区块"],
    ["simulationDistance", "模拟距离", 2, 32, 1, "区块"],
    ["maxFps", "最大帧率", 10, 260, 1, "FPS"],
    ["guiScale", "界面缩放", 0, 6, 1, "（0 自动）"],
    ["soundCategory_master", "主音量", 0, 1, 0.05, ""],
    ["gamma", "亮度", 0, 1, 0.05, ""],
    ["fov", "视野", 30, 110, 1, "°"],
  ];
  return (
    <div className="options-grid game-options-fields">
      {sliders.map(([key, label, min, max, step, unit]) => {
        const current =
          key === "fov"
            ? Math.round(Number(options.fov) * 40 + 70)
            : Number(options[key]);
        return (
          <div className="field slider-field game-option-card" key={key}>
            <div className="game-option-label">
              <label htmlFor={`${idPrefix}-${key}`}>{label}</label>
              <output htmlFor={`${idPrefix}-${key}`}>
                {current} {unit}
              </output>
            </div>
            <input
              id={`${idPrefix}-${key}`}
              type="range"
              min={min}
              max={max}
              step={step}
              value={current}
              onChange={(e) =>
                onChange(
                  key,
                  key === "fov"
                    ? (Number(e.target.value) - 70) / 40
                    : Number(e.target.value),
                )
              }
            />
          </div>
        );
      })}
      <div className="field game-option-card">
        <label htmlFor={`${idPrefix}-graphics`}>图像品质</label>
        <select
          id={`${idPrefix}-graphics`}
          value={Number(options.graphicsMode)}
          onChange={(e) => onChange("graphicsMode", Number(e.target.value))}
        >
          <option value={0}>流畅</option>
          <option value={1}>高品质</option>
          <option value={2}>极佳</option>
        </select>
      </div>
      <div className="field game-option-card">
        <label htmlFor={`${idPrefix}-language`}>游戏语言</label>
        <select
          id={`${idPrefix}-language`}
          value={String(options.lang)}
          onChange={(e) => onChange("lang", e.target.value)}
        >
          <option value="zh_cn">简体中文</option>
          <option value="zh_tw">繁體中文</option>
          <option value="en_us">English (US)</option>
          {!["zh_cn", "zh_tw", "en_us"].includes(String(options.lang)) && (
            <option value={String(options.lang)}>{options.lang}</option>
          )}
        </select>
      </div>
      {[
        ["fullscreen", "全屏显示"],
        ["enableVsync", "垂直同步"],
        ["autoJump", "自动跳跃"],
        ["bobView", "视角摇晃"],
      ].map(([key, label]) => (
        <div className="setting-row compact game-option-toggle" key={key}>
          <span>{label}</span>
          <button
            type="button"
            className={`toggle ${options[key] ? "on" : ""}`}
            aria-label={label}
            aria-pressed={Boolean(options[key])}
            onClick={() => onChange(key, !options[key])}
          >
            <span />
          </button>
        </div>
      ))}
    </div>
  );
}
