import { KeyRound, Save, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import type { LauncherAPI } from "../../shared/types";
import { AI_DISABLED_MESSAGE } from "../../shared/ai";
import "./ai-settings.css";

export default function AISettings(_props: {
  call: LauncherAPI["call"];
  refresh?: () => Promise<void>;
}) {
  return (
    <section className="ai-settings" aria-label="AI 服务设置">
      <header className="ai-settings-heading">
        <span className="ai-settings-icon">
          <Sparkles size={21} />
        </span>
        <div>
          <span className="eyebrow">AI PREVIEW</span>
          <h3>AI 辅助与配置建议</h3>
        </div>
      </header>
      <p className="ai-preview-notice" role="status">
        {AI_DISABLED_MESSAGE}
      </p>
      <p className="muted">
        本地规则诊断可正常使用。以下为界面预览，服务配置、密钥和配置建议暂不可用。
      </p>
      <div className="setting-row">
        <div>
          <strong>启用 AI 服务</strong>
          <p>功能暂未启用</p>
        </div>
        <button
          type="button"
          className="toggle"
          aria-label="启用 AI 服务"
          aria-pressed={false}
          disabled
          title={AI_DISABLED_MESSAGE}
        >
          <span />
        </button>
      </div>
      <div className="ai-settings-grid">
        <label className="field">
          提供方
          <select defaultValue="openai-compatible" disabled>
            <option value="openai-compatible">OpenAI 兼容 API</option>
            <option value="mock">Mock · 接口预览</option>
          </select>
        </label>
        <label className="field">
          超时（秒）
          <input type="number" min={1} max={60} placeholder="30" disabled />
        </label>
        <label className="field ai-settings-wide">
          服务地址
          <input
            type="url"
            spellCheck={false}
            placeholder="https://api.example.com/v1"
            disabled
          />
        </label>
        <label className="field">
          模型名称
          <input spellCheck={false} placeholder="功能启用后配置" disabled />
        </label>
        <label className="field">
          API Key
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder="功能暂未启用"
            disabled
          />
        </label>
      </div>
      <p className="ai-key-status">
        <KeyRound size={15} />
        配置与密钥功能暂未启用
      </p>
      <div className="button-group">
        <button className="btn primary" disabled>
          <Save size={15} />
          保存 AI 设置
        </button>
        <button className="btn subtle" disabled>
          <Trash2 size={15} />
          清除 Key
        </button>
      </div>
      <div className="ai-configuration">
        <h3>用自然语言预览游戏配置</h3>
        <p className="muted">功能暂未启用，暂不可生成或应用配置建议。</p>
        <label className="field">
          描述需求
          <textarea
            rows={3}
            maxLength={2000}
            placeholder="例如：电脑内存较小，希望优先保证稳定运行"
            disabled
          />
        </label>
        <button className="btn subtle" disabled>
          <Sparkles size={15} />
          生成配置差异
        </button>
        <div className="ai-suggestion">
          <div className="ai-suggestion-heading">
            <strong>
              <ShieldCheck size={17} />
              配置预览
            </strong>
            <small>功能暂未启用</small>
          </div>
          <p className="muted">功能启用后将在这里显示配置差异。</p>
          <button className="btn primary" disabled>
            明确应用这些更改
          </button>
        </div>
      </div>
    </section>
  );
}
