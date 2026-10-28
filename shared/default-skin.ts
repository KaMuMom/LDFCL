/** Unmodified Mojang Steve template, bundled for offline classic-model previews.
 * Source: https://assets.mojang.com/SkinTemplates/steve.png
 * Copyright Mojang/Microsoft; see THIRD_PARTY_NOTICES.md.
 */
export const DEFAULT_SKIN_NAME = "Steve";

export function defaultSkinTexture(): string {
  // Relative to index.html in both the Vite server and the packaged file:// UI.
  return "./skins/steve.png";
}
