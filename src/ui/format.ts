export const loaderName = (loader: string) =>
  ({
    vanilla: "原版",
    fabric: "Fabric",
    quilt: "Quilt",
    forge: "Forge",
    neoforge: "NeoForge",
    optifine: "OptiFine",
  })[loader] || loader;

export const errorMessage = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );
