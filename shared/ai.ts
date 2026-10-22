export interface AISettings {
  enabled: boolean;
  provider: "mock" | "openai-compatible";
  baseUrl: string;
  model: string;
  timeoutMs: number;
  keyConfigured: boolean;
  encryptionAvailable: boolean;
  keyPersistence: "encrypted" | "memory" | "none";
  warning?: string;
}

export type AIConfigurationValues = {
  memoryMode: "auto" | "manual";
  memoryMb: number;
  javaPath: string;
  jvmArgs: string[];
};

export interface AIConfigurationSuggestion {
  id: string;
  createdAt: string;
  source: "mock" | "openai-compatible" | "rules";
  summary: string;
  changes: Partial<AIConfigurationValues>;
  diff: { key: keyof AIConfigurationValues; before: unknown; after: unknown }[];
  warnings: string[];
  requiresApply: true;
}
/** AI is suspended in the launcher; its page remains a static preview. */
export const AI_DISABLED_MESSAGE = "AI 功能暂未启用，当前仅保留界面预览。";
