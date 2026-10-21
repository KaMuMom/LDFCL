#!/usr/bin/env node
"use strict";

// node build/package-ui-gallery.cjs [review-directory | manifest.json]
// Uses only Node and Windows' built-in PowerShell/System.Drawing. No desktop opens.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const currentVersion = require("../package.json").version;
const captureDay = new Date()
  .toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" })
  .replace(/-/g, "");
const requested = path.resolve(
  process.argv[2] ||
    path.join(
      __dirname,
      "..",
      "release",
      `ui-review-${currentVersion}-${captureDay}`,
    ),
);
const manifestFile =
  path.extname(requested).toLowerCase() === ".json"
    ? requested
    : path.join(requested, "manifest.json");
const root = path.dirname(manifestFile);

function safeRelativeFile(value) {
  if (
    typeof value !== "string" ||
    !value ||
    path.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  )
    throw new Error("截图必须使用非空相对路径");
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    /[\x00-\x1f?#]/.test(normalized)
  )
    throw new Error(`无效截图路径：${value}`);
  const full = path.resolve(root, normalized);
  const relative = path.relative(root, full);
  if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error(`截图路径越界：${value}`);
  if (
    path.extname(full).toLowerCase() !== ".png" ||
    !fs.statSync(full).isFile()
  )
    throw new Error(`截图不是可读取的 PNG：${value}`);
  return normalized;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

function imageUrl(file) {
  return file.split("/").map(encodeURIComponent).join("/");
}

function main() {
  if (process.platform !== "win32")
    throw new Error(
      "联系图使用 Windows System.Drawing，请在 Windows 上运行此脚本。",
    );
  const source = JSON.parse(
    fs.readFileSync(manifestFile, "utf8").replace(/^\uFEFF/, ""),
  );
  if (!source || !Array.isArray(source.groups) || !source.groups.length)
    throw new Error("manifest.groups 必须包含至少一个截图分组");
  let number = 0;
  const groups = source.groups.map((group, index) => {
    if (!group || !Array.isArray(group.items) || !group.items.length)
      throw new Error(`第 ${index + 1} 个分组没有截图`);
    return {
      id: String(group.id || `group-${index + 1}`),
      title: String(group.title || `分组 ${index + 1}`),
      anchor: `group-${index + 1}`,
      sheet: `contact-sheets/${String(index + 1).padStart(2, "0")}-${String(
        group.id || "group",
      )
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 60)}.png`,
      items: group.items.map((item, itemIndex) => {
        if (!item || typeof item !== "object")
          throw new Error(`第 ${index + 1} 组第 ${itemIndex + 1} 张截图无效`);
        const file = safeRelativeFile(item.file);
        return {
          id: String(item.id || `image-${number + 1}`),
          title: String(item.title || `截图 ${number + 1}`),
          description: String(item.description || ""),
          file,
          url: imageUrl(file),
          number: ++number,
        };
      }),
    };
  });
  const data = {
    version: String(source.version || currentVersion),
    capturedAt: String(source.capturedAt || ""),
    note: String(source.note || ""),
    window: source.window || {},
    groups,
  };
  const serialized = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const navigation = groups
    .map(
      (group) =>
        `<a href="#${group.anchor}"><span>${escapeHtml(group.title)}</span><b>${group.items.length}</b></a>`,
    )
    .join("");
  const sections = groups
    .map(
      (group) =>
        `<section id="${group.anchor}" class="group"><header class="group-heading"><div><p class="eyebrow">${escapeHtml(group.id)}</p><h2>${escapeHtml(group.title)}</h2></div><a class="sheet-link" href="${imageUrl(group.sheet)}" target="_blank" rel="noopener">查看双列联系图 ↗</a></header><div class="grid">${group.items.map((item) => `<button class="card" data-index="${item.number - 1}" aria-label="放大：${escapeHtml(item.title)}"><div class="thumbnail"><img src="${item.url}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async"><span class="number">${String(item.number).padStart(2, "0")}</span></div><div class="caption"><h3>${escapeHtml(item.title)}</h3>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}<span>${escapeHtml(item.file)}</span></div></button>`).join("")}</div></section>`,
    )
    .join("");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LDFCL ${escapeHtml(data.version)} 界面截图审阅</title>
<style>
:root{color-scheme:dark;--bg:#101317;--panel:#191e24;--line:#303842;--muted:#9ba9b8;--accent:#a4d9bc}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:#ecf2f6;font-family:"Microsoft YaHei UI","Segoe UI",sans-serif;line-height:1.55}button,a{-webkit-tap-highlight-color:transparent}a{color:inherit}button{font:inherit}.layout{display:grid;grid-template-columns:244px minmax(0,1fr);max-width:1800px;margin:auto;min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;padding:32px 20px;border-right:1px solid var(--line);overflow:auto}.brand{font-size:24px;font-weight:750;letter-spacing:1px}.badge{display:inline-block;margin-top:12px;padding:4px 10px;border-radius:8px;background:#25372e;color:var(--accent);font-size:12px}.sidebar p{color:var(--muted);font-size:13px;margin:20px 0}.navigation{display:grid;gap:6px}.navigation a{display:flex;justify-content:space-between;align-items:center;gap:12px;text-decoration:none;border-radius:10px;padding:11px 12px;font-size:14px}.navigation a:hover,.navigation a:focus-visible{background:#26312d;outline:2px solid transparent}.navigation b{font-size:12px;color:var(--muted);font-weight:400}.main{padding:44px 44px 70px;min-width:0}.intro{margin-bottom:42px}.eyebrow{text-transform:uppercase;letter-spacing:1.8px;font-size:11px;color:var(--accent);margin:0 0 8px}.intro h1{font-size:clamp(25px,3vw,38px);line-height:1.25;margin:0 0 16px}.intro p{color:var(--muted);margin:5px 0;font-size:14px}.intro .hint{font-size:12px;margin-top:18px}.group{margin-bottom:52px}.group-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.group-heading h2{font-size:23px;line-height:1.3;margin:0}.sheet-link{font-size:12px;color:var(--accent);white-space:nowrap;text-decoration:none}.sheet-link:hover{text-decoration:underline}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.card{display:block;background:var(--panel);border:1px solid var(--line);padding:0;color:inherit;text-align:left;border-radius:12px;overflow:hidden;cursor:zoom-in;min-width:0;transition:border-color .15s,transform .15s}.card:hover{border-color:#7d9e8b;transform:translateY(-2px)}.card:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.thumbnail{position:relative;aspect-ratio:${Math.max(1, Number(data.window.width) || 1440)}/${Math.max(1, Number(data.window.height) || 960)};background:#0b0e11;display:grid;place-items:center}.thumbnail img{display:block;width:100%;height:100%;object-fit:contain}.number{position:absolute;left:10px;top:10px;background:#101719e8;color:#c7e8d5;border:1px solid #657b70;border-radius:6px;font-size:12px;font-weight:700;padding:3px 7px}.caption{padding:16px 17px 17px}.caption h3{font-size:15px;line-height:1.5;margin:0 0 6px}.caption p{font-size:12px;color:#bfccd6;margin:0 0 8px}.caption span{display:block;font-size:10px;color:var(--muted);overflow-wrap:anywhere}dialog{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;margin:0;border:0;padding:0;background:#0c1015f5;color:inherit}dialog::backdrop{background:#000d}.viewer{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto}.toolbar{display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--line)}.toolbar-title{min-width:0;flex:1}.toolbar-title strong{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar-title span{display:block;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.control{border:1px solid #43505e;background:#202832;color:#eef5fa;text-decoration:none;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;white-space:nowrap}.control:hover{background:#33423f}.control:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.image-stage{min-height:0;display:grid;grid-template-columns:60px minmax(0,1fr) 60px;align-items:center;gap:10px;padding:14px}.full-image{min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;height:100%;overflow:hidden}.full-image img{display:block;max-width:100%;max-height:100%;object-fit:contain}.arrow{font-size:30px;padding:10px 0}.viewer-footer{padding:12px 22px 18px;text-align:center;color:var(--muted);font-size:12px}.viewer-footer p{margin:0 0 4px;color:#d7e1e9}.no-scroll{overflow:hidden}footer{padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}@media(min-width:1500px){.grid{gap:24px}}@media(max-width:1000px){.layout{grid-template-columns:200px minmax(0,1fr)}.main{padding:32px 24px}.sidebar{padding:28px 16px}.grid{gap:14px}.caption{padding:12px}.group-heading{align-items:flex-start;flex-direction:column;gap:10px}}@media(max-width:760px){html{scroll-padding-top:18px}.layout{display:block}.sidebar{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:20px}.sidebar p{margin:12px 0}.brand{display:inline-block;margin-right:12px}.badge{margin:0}.navigation{display:flex;flex-wrap:wrap;gap:6px}.navigation a{padding:6px 10px;background:var(--panel);font-size:12px}.navigation b{font-size:10px}.main{padding:28px 18px 44px}.intro{margin-bottom:30px}.grid{grid-template-columns:1fr}.group{margin-bottom:38px}.toolbar{padding:12px;gap:8px}.toolbar-title strong{font-size:13px}.toolbar-title span{font-size:10px}.control{padding:6px 9px;font-size:12px}.image-stage{grid-template-columns:34px minmax(0,1fr) 34px;gap:5px;padding:8px 4px}.arrow{font-size:24px}.viewer-footer{padding:8px 14px 18px;font-size:11px}}
</style></head><body><div class="layout"><aside class="sidebar"><div class="brand">LDFCL</div><div class="badge">${escapeHtml(data.version)} · 界面审阅</div><p>真实应用截图<br>${number} 张截图 · ${groups.length} 个分组</p><nav class="navigation" aria-label="截图分组">${navigation}</nav></aside><main class="main"><header class="intro"><p class="eyebrow">INTERFACE REVIEW</p><h1>每一处界面，一次看清。</h1><p>按功能浏览 LDFCL 的真实界面截图，点击任意缩略图即可放大查看。</p><p>截图时间：${escapeHtml(data.capturedAt || "未记录")}　窗口：${escapeHtml(data.window.width || "—")} × ${escapeHtml(data.window.height || "—")}</p>${data.note ? `<p class="review-note">${escapeHtml(data.note)}</p>` : ""}<p class="hint">放大后可用 ← / → 切换，Esc 关闭；“下载原图”保留截图原始尺寸。</p></header>${sections}<footer>本相册只缩放显示截图，未重绘或修改应用界面。所有原始 PNG 位于 screenshots 文件夹。</footer></main></div>
<dialog id="lightbox" aria-label="截图原图查看器"><div class="viewer"><header class="toolbar"><div class="toolbar-title"><strong id="viewer-title"></strong><span id="viewer-path"></span></div><a id="download" class="control" download>下载原图</a><button id="close" class="control" aria-label="关闭原图查看器">关闭 ✕</button></header><div class="image-stage"><button id="previous" class="control arrow" aria-label="上一张截图">‹</button><div class="full-image"><img id="viewer-image" alt=""></div><button id="next" class="control arrow" aria-label="下一张截图">›</button></div><footer class="viewer-footer"><p id="viewer-description"></p><span id="viewer-counter" aria-live="polite"></span> · ← / → 切换 · Esc 关闭</footer></div></dialog>
<script id="gallery-data" type="application/json">${serialized}</script><script>
const data=JSON.parse(document.getElementById('gallery-data').textContent);const items=data.groups.flatMap(group=>group.items.map(item=>({...item,group:group.title})));const dialog=document.getElementById('lightbox');let current=0;let opener=null;
function show(index){current=(index+items.length)%items.length;const item=items[current];document.getElementById('viewer-title').textContent=String(item.number).padStart(2,'0')+' · '+item.title;document.getElementById('viewer-path').textContent=item.group+' / '+item.file;const image=document.getElementById('viewer-image');image.src=item.url;image.alt=item.title;const download=document.getElementById('download');download.href=item.url;download.download=item.file.split('/').pop();document.getElementById('viewer-description').textContent=item.description;document.getElementById('viewer-counter').textContent=(current+1)+' / '+items.length;}
document.querySelectorAll('.card').forEach(card=>card.addEventListener('click',()=>{opener=card;show(Number(card.dataset.index));dialog.showModal();document.body.classList.add('no-scroll');}));document.getElementById('close').addEventListener('click',()=>dialog.close());document.getElementById('previous').addEventListener('click',()=>show(current-1));document.getElementById('next').addEventListener('click',()=>show(current+1));dialog.addEventListener('close',()=>{document.body.classList.remove('no-scroll');if(opener)opener.focus();});dialog.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'){event.preventDefault();show(current-1);}else if(event.key==='ArrowRight'){event.preventDefault();show(current+1);}else if(event.key==='Home'){event.preventDefault();show(0);}else if(event.key==='End'){event.preventDefault();show(items.length-1);}});
</script></body></html>`;

  const powershell = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$galleryRoot = $env:LDFCL_GALLERY_ROOT
$gallery = $env:LDFCL_GALLERY_DATA | ConvertFrom-Json
$fontFamily = 'Microsoft YaHei UI'
$fontTitle = New-Object System.Drawing.Font($fontFamily, 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontGroup = New-Object System.Drawing.Font($fontFamily, 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fontCaption = New-Object System.Drawing.Font($fontFamily, 23, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontDescription = New-Object System.Drawing.Font($fontFamily, 17, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#eef3f7'))
$mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#aab8c7'))
$tileBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#1b222a'))
$linePen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#38434f'), 1)
$format = New-Object System.Drawing.StringFormat
$format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
$format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
$sheetWidth = 2048
$margin = 32
$gap = 24
$tileWidth = 980
try {
  foreach ($group in $gallery.groups) {
    $loaded = New-Object System.Collections.Generic.List[object]
    $bitmap = $null
    $graphics = $null
    try {
      $imageHeight = 0
      foreach ($item in $group.items) {
        $imagePath = Join-Path $galleryRoot ($item.file.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        $sourceImage = [System.Drawing.Image]::FromFile($imagePath)
        $loaded.Add([pscustomobject]@{ Item = $item; Image = $sourceImage })
        $imageHeight = [Math]::Max($imageHeight, [Math]::Ceiling($tileWidth * $sourceImage.Height / $sourceImage.Width))
      }
      $imageHeight = [int]$imageHeight
      $captionHeight = 116
      $tileHeight = $imageHeight + $captionHeight
      $rows = [int][Math]::Ceiling($loaded.Count / 2.0)
      $hasNote = -not [string]::IsNullOrWhiteSpace([string]$gallery.note)
      $headerHeight = if ($hasNote) { 196 } else { 144 }
      $sheetHeight = $headerHeight + $rows * $tileHeight + [Math]::Max(0, $rows - 1) * $gap + 58
      if ($sheetHeight -gt 60000) { throw ('联系图过高，请拆分截图分组：' + $group.title) }
      $bitmap = New-Object System.Drawing.Bitmap($sheetWidth, $sheetHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#10151b'))
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
      $heading = 'LDFCL ' + $gallery.version + ' / ' + $group.title
      $graphics.DrawString($heading, $fontTitle, $textBrush, [System.Drawing.RectangleF]::new($margin, 28, $sheetWidth - 2 * $margin, 52), $format)
      $subtitle = [string]$loaded.Count + ' 张真实截图 · 双列审阅 · 编号与相册一致'
      $graphics.DrawString($subtitle, $fontGroup, $mutedBrush, [System.Drawing.PointF]::new($margin, 88))
      if ($hasNote) {
        $graphics.DrawString([string]$gallery.note, $fontDescription, $mutedBrush, [System.Drawing.RectangleF]::new($margin, 128, $sheetWidth - 2 * $margin, 48), $format)
      }
      for ($index = 0; $index -lt $loaded.Count; $index++) {
        $entry = $loaded[$index]
        $column = $index % 2
        $row = [int][Math]::Floor($index / 2.0)
        $x = $margin + $column * ($tileWidth + $gap)
        $y = $headerHeight + $row * ($tileHeight + $gap)
        $graphics.FillRectangle($tileBrush, $x, $y, $tileWidth, $tileHeight)
        $scale = [Math]::Min($tileWidth / [double]$entry.Image.Width, $imageHeight / [double]$entry.Image.Height)
        $drawWidth = [int][Math]::Round($entry.Image.Width * $scale)
        $drawHeight = [int][Math]::Round($entry.Image.Height * $scale)
        $drawX = $x + [int][Math]::Floor(($tileWidth - $drawWidth) / 2.0)
        $drawY = $y + [int][Math]::Floor(($imageHeight - $drawHeight) / 2.0)
        $graphics.DrawImage($entry.Image, [System.Drawing.Rectangle]::new($drawX, $drawY, $drawWidth, $drawHeight), 0, 0, $entry.Image.Width, $entry.Image.Height, [System.Drawing.GraphicsUnit]::Pixel)
        $graphics.DrawRectangle($linePen, $x, $y, $tileWidth - 1, $tileHeight - 1)
        $caption = ([int]$entry.Item.number).ToString('00') + '  ' + $entry.Item.title
        $graphics.DrawString($caption, $fontCaption, $textBrush, [System.Drawing.RectangleF]::new($x + 18, $y + $imageHeight + 12, $tileWidth - 36, 38), $format)
        $detail = [string]$entry.Item.description
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = [string]$entry.Item.file }
        $graphics.DrawString($detail, $fontDescription, $mutedBrush, [System.Drawing.RectangleF]::new($x + 18, $y + $imageHeight + 57, $tileWidth - 36, 48), $format)
      }
      $graphics.DrawString('原始截图仅等比缩放；完整原图请打开 index.html。', $fontDescription, $mutedBrush, [System.Drawing.PointF]::new($margin, $sheetHeight - 38))
      $sheetPath = Join-Path $galleryRoot ($group.sheet.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($sheetPath)) | Out-Null
      $bitmap.Save($sheetPath, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output $sheetPath
    } finally {
      if ($graphics) { $graphics.Dispose() }
      if ($bitmap) { $bitmap.Dispose() }
      foreach ($entry in $loaded) { $entry.Image.Dispose() }
    }
  }
} finally {
  $fontTitle.Dispose(); $fontGroup.Dispose(); $fontCaption.Dispose(); $fontDescription.Dispose()
  $textBrush.Dispose(); $mutedBrush.Dispose(); $tileBrush.Dispose(); $linePen.Dispose(); $format.Dispose()
}
`;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(powershell, "utf16le").toString("base64"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        LDFCL_GALLERY_ROOT: root,
        LDFCL_GALLERY_DATA: JSON.stringify(data),
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `联系图生成失败（退出码 ${result.status}）：\n${result.stderr || result.stdout}`,
    );
  for (const group of groups) {
    const file = path.join(root, group.sheet);
    if (!fs.existsSync(file) || fs.statSync(file).size < 100)
      throw new Error(`联系图未成功保存：${file}`);
  }
  const indexFile = path.join(root, "index.html");
  fs.writeFileSync(indexFile, html, "utf8");
  console.log(`相册：${indexFile}`);
  console.log(`截图：${number} 张 / ${groups.length} 组`);
  for (const group of groups)
    console.log(`联系图：${path.join(root, group.sheet)}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
