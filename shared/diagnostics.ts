export type CrashCategory =
  | "memory"
  | "java"
  | "dependency"
  | "duplicate-mod"
  | "mixin"
  | "graphics"
  | "launch"
  | "unknown";

export interface DiagnosisEvidence {
  source: string;
  line: number;
  snippet: string;
  ruleId: string;
}

export interface SuspectedMod {
  id: string;
  name: string;
  reason: string;
  confidence: number;
}

export interface AIEnhancement {
  status: "enhanced" | "fallback" | "disabled";
  provider: "mock" | "openai-compatible";
  generatedAt: string;
  summary?: string;
  recommendations?: string[];
  suspectedMods?: SuspectedMod[];
  message?: string;
}

/** Rule evidence is immutable input to optional AI enhancement. */
export interface CrashDiagnosis {
  schemaVersion: 1;
  id: string;
  runId: string;
  instanceId: string;
  createdAt: string;
  exitCode: number | null;
  terminationReason: "crash" | "launch-error" | "imported";
  category: CrashCategory;
  summary: string;
  confidence: number;
  suspectedMods: SuspectedMod[];
  evidence: DiagnosisEvidence[];
  recommendations: string[];
  ruleVersion: string;
  source: "rules";
  logTail: string[];
  collectedFiles: string[];
  warnings: string[];
  ai?: AIEnhancement;
}

export interface DiagnosisMod {
  id: string;
  name?: string;
  filename?: string;
  ids?: string[];
}

export interface DiagnosisSharePayload {
  category: CrashCategory;
  summary: string;
  confidence: number;
  suspectedMods: SuspectedMod[];
  evidence: DiagnosisEvidence[];
  recommendations: string[];
  logTail: string[];
}
