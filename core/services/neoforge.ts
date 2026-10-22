import { requestJson } from "./downloads";

export function neoforgeArtifact(gameVersion: string): string {
  return gameVersion === "1.20.1" ? "forge" : "neoforge";
}
export function neoforgeVersionMatches(
  gameVersion: string,
  loaderVersion: string,
): boolean {
  if (gameVersion === "1.20.1") return /^1\.20\.1-47\./.test(loaderVersion);
  const calendar = /^(2\d)\.(\d+)(?:\.(\d+))?$/.exec(gameVersion);
  if (calendar)
    return (
      loaderVersion.startsWith(
        `${calendar[1]}.${Number(calendar[2])}.${Number(calendar[3] || 0)}.`,
      ) && /^[\dA-Za-z.\-]+$/.test(loaderVersion)
    );
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(gameVersion);
  return (
    !!match &&
    loaderVersion.startsWith(`${Number(match[1])}.${Number(match[2] || 0)}.`) &&
    /^[\dA-Za-z.\-]+$/.test(loaderVersion)
  );
}
export async function neoforgeVersions(gameVersion: string): Promise<string[]> {
  const artifact = neoforgeArtifact(gameVersion);
  const result = await requestJson<{ versions: string[] }>(
    `https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/${artifact}`,
  );
  if (!Array.isArray(result.versions))
    throw new Error("NeoForge 版本列表格式无效");
  return result.versions
    .filter(
      (version) =>
        typeof version === "string" &&
        neoforgeVersionMatches(gameVersion, version),
    )
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}
