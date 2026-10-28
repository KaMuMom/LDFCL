import { SlidersHorizontal } from "lucide-react";
import type { Settings } from "../../shared/types";
import { GAME_OPTION_DEFAULTS } from "../../shared/game-settings";
import GameOptionsFields from "./GameOptionsFields";
import { GlassSurface } from "../ui/Glass";
import "./game-options.css";

export default function GeneralGameSettings({
  value,
  onChange,
}: {
  value: Settings["gameDefaults"];
  onChange: (value: NonNullable<Settings["gameDefaults"]>) => void;
}) {
  const enabled = Object.keys(value || {}).length > 0;
  return (
    <GlassSurface
      className="settings-panel full-span general-game-settings"
      aria-label="通用游戏设置"
    >
      <header className="general-game-heading">
        <span className="general-game-emblem">
          <SlidersHorizontal size={21} />
        </span>
        <div>
          <span className="eyebrow">GAME PREFERENCES</span>
          <h3>通用游戏设置</h3>
        </div>
      </header>
      <div className="setting-row general-game-switch">
        <div>
          <strong>启用通用游戏设置</strong>
          <p>在启动前应用到各个版本，实例的单独预设优先。</p>
        </div>
        <button
          className={`toggle ${enabled ? "on" : ""}`}
          aria-label="启用通用游戏设置"
          aria-pressed={enabled}
          onClick={() => onChange(enabled ? {} : { ...GAME_OPTION_DEFAULTS })}
        >
          <span />
        </button>
      </div>
      {enabled && (
        <>
          <GameOptionsFields
            value={value || {}}
            idPrefix="global-game"
            onChange={(key, option) =>
              onChange({ ...GAME_OPTION_DEFAULTS, ...value, [key]: option })
            }
          />
          <p className="muted general-game-hint">
            点击页面顶部「保存设置」后，下次启动生效。正在运行的游戏请先退出；部分选项仅适用于较新游戏版本。
          </p>
        </>
      )}
      {!enabled && (
        <p className="muted general-game-hint">
          关闭时保留游戏自己的设置；尚未设置游戏语言时默认简体中文。你仍可在「游戏实例
          → 游戏预设」为单个版本配置。
        </p>
      )}
    </GlassSurface>
  );
}
