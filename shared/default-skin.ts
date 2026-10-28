/** Original LDFCL Forest Explorer artwork, using Minecraft's classic 64x64 UV layout. */
export function drawDefaultSkin(context: {
  fillStyle: string | CanvasGradient | CanvasPattern;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
}): void {
  context.clearRect(0, 0, 64, 64);
  context.fillStyle = "#bd9270";
  context.fillRect(8, 0, 16, 8);
  context.fillRect(0, 8, 32, 8);
  context.fillRect(40, 16, 16, 16);
  context.fillRect(32, 48, 16, 16);

  // Top, both sides and back are separate UV faces. Painting one continuous
  // strip left a bald side and a skin-coloured seam along the top of the head.
  context.fillStyle = "#302e30";
  context.fillRect(8, 0, 8, 8);
  context.fillRect(0, 8, 8, 8);
  context.fillRect(16, 8, 16, 8);
  context.fillRect(8, 8, 8, 2);
  context.fillRect(8, 10, 1, 3);
  context.fillRect(15, 10, 1, 3);
  context.fillStyle = "#bd9270";
  context.fillRect(4, 12, 2, 2);
  context.fillRect(18, 12, 2, 2);
  context.fillStyle = "#f6f6ea";
  context.fillRect(9, 11, 2, 1);
  context.fillRect(13, 11, 2, 1);
  context.fillStyle = "#1d3436";
  context.fillRect(10, 11, 1, 1);
  context.fillRect(13, 11, 1, 1);
  context.fillStyle = "#986c57";
  context.fillRect(11, 13, 2, 1);
  context.fillStyle = "#5b8d7c";
  context.fillRect(16, 16, 24, 16);
  context.fillRect(40, 16, 16, 6);
  context.fillRect(32, 48, 16, 6);
  context.fillStyle = "#e2e2cc";
  context.fillRect(20, 20, 8, 1);
  context.fillRect(23, 21, 2, 5);
  context.fillStyle = "#293e48";
  context.fillRect(0, 16, 16, 16);
  context.fillRect(16, 48, 16, 16);
  context.fillStyle = "#1e292e";
  context.fillRect(0, 29, 16, 3);
  context.fillRect(16, 61, 16, 3);
}

export function defaultSkinTexture(): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  drawDefaultSkin(canvas.getContext("2d")!);
  return canvas.toDataURL("image/png");
}
