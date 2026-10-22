export type HealthSeverity = "error" | "warning" | "info";
export interface HealthIssue {
  id: string;
  category: "java" | "dependency" | "memory" | "logs" | "files";
  severity: HealthSeverity;
  title: string;
  detail: string;
  suggestion: string;
  autoFix?: "memory" | "java-auto" | "enable-dependency";
  file?: string;
}
export interface HealthReport {
  schemaVersion: 1;
  instanceId: string;
  scannedAt: string;
  score: number;
  status: "healthy" | "warning" | "error";
  issues: HealthIssue[];
  requiredJava: number;
  memoryMb: number;
  limits: string[];
}
export interface HealthFixLog {
  issueId: string;
  status: "fixed" | "skipped" | "failed";
  description: string;
}
