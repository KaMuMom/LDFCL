export type DownloadSource = "official" | "bmclapi";
let selectedSource: DownloadSource = "official";

export function setDownloadSource(source: DownloadSource): void {
  if (source !== "official" && source !== "bmclapi")
    throw new Error("不支持的下载源");
  selectedSource = source;
}
export function getDownloadSource(): DownloadSource {
  return selectedSource;
}

/** Only public game artifacts are mapped. Authentication and unknown hosts stay official. */
export function downloadUrls(value: string, source = selectedSource): string[] {
  const url = new URL(value);
  if (
    source !== "bmclapi" ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port
  )
    return [value];
  let pathname: string | undefined;
  if (
    url.hostname === "piston-meta.mojang.com" ||
    url.hostname === "launchermeta.mojang.com"
  )
    pathname =
      url.pathname === "/mc/game/version_manifest_v2.json" ||
      url.pathname === "/mc/game/version_manifest.json"
        ? "/version_manifest_v2.json"
        : url.pathname;
  else if (
    ["piston-data.mojang.com", "launcher.mojang.com"].includes(url.hostname)
  )
    pathname = url.pathname;
  else if (url.hostname === "resources.download.minecraft.net")
    pathname = `/assets${url.pathname}`;
  else if (
    ["libraries.minecraft.net", "maven.minecraftforge.net"].includes(
      url.hostname,
    )
  )
    pathname = `/maven${url.pathname}`;
  else if (url.hostname === "meta.fabricmc.net")
    pathname = `/fabric-meta${url.pathname}`;
  if (!pathname) return [value];
  return [`https://bmclapi2.bangbang93.com${pathname}${url.search}`, value];
}
