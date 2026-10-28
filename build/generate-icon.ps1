param(
  [string]$SourcePath = (Join-Path $PSScriptRoot 'icon-source.png')
)

# The user-provided artwork is retained as icon-source.webp and its lossless
# PNG decode. Point sampling preserves the transparent pixel-art edges.
Add-Type -AssemblyName System.Drawing
$iconSource = [System.Drawing.Bitmap]::new((Resolve-Path -LiteralPath $SourcePath).Path)
$iconSizes = @(16, 24, 32, 48, 64, 128, 256)
$iconFrames = [System.Collections.Generic.List[byte[]]]::new()
$iconPngPath = Join-Path $PSScriptRoot '../public/icon.png'
$iconIcoPath = Join-Path $PSScriptRoot 'icon.ico'

try {
  foreach ($iconSize in $iconSizes) {
    $iconBitmap = [System.Drawing.Bitmap]::new(
      $iconSize,
      $iconSize,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $iconStream = [System.IO.MemoryStream]::new()
    try {
      for ($iconY = 0; $iconY -lt $iconSize; $iconY++) {
        $iconSourceY = [int][Math]::Floor(($iconY + 0.5) * $iconSource.Height / $iconSize)
        for ($iconX = 0; $iconX -lt $iconSize; $iconX++) {
          $iconSourceX = [int][Math]::Floor(($iconX + 0.5) * $iconSource.Width / $iconSize)
          $iconBitmap.SetPixel($iconX, $iconY, $iconSource.GetPixel($iconSourceX, $iconSourceY))
        }
      }
      $iconBitmap.Save($iconStream, [System.Drawing.Imaging.ImageFormat]::Png)
      $iconBytes = $iconStream.ToArray()
      $iconFrames.Add($iconBytes)
      if ($iconSize -eq 256) {
        [System.IO.File]::WriteAllBytes($iconPngPath, $iconBytes)
      }
    } finally {
      $iconStream.Dispose()
      $iconBitmap.Dispose()
    }
  }

  $iconFile = [System.IO.File]::Create($iconIcoPath)
  $iconWriter = [System.IO.BinaryWriter]::new($iconFile)
  try {
    $iconWriter.Write([uint16]0)
    $iconWriter.Write([uint16]1)
    $iconWriter.Write([uint16]$iconSizes.Count)
    $iconOffset = 6 + 16 * $iconSizes.Count
    for ($iconIndex = 0; $iconIndex -lt $iconSizes.Count; $iconIndex++) {
      $iconDimension = if ($iconSizes[$iconIndex] -eq 256) { 0 } else { $iconSizes[$iconIndex] }
      $iconWriter.Write([byte]$iconDimension)
      $iconWriter.Write([byte]$iconDimension)
      $iconWriter.Write([byte]0)
      $iconWriter.Write([byte]0)
      $iconWriter.Write([uint16]1)
      $iconWriter.Write([uint16]32)
      $iconWriter.Write([uint32]$iconFrames[$iconIndex].Length)
      $iconWriter.Write([uint32]$iconOffset)
      $iconOffset += $iconFrames[$iconIndex].Length
    }
    foreach ($iconFrame in $iconFrames) {
      $iconWriter.Write([byte[]]$iconFrame)
    }
  } finally {
    $iconWriter.Dispose()
  }
} finally {
  $iconSource.Dispose()
}

Write-Output 'Generated user-selected transparent PNG and 7-size ICO with nearest-neighbor sampling.'
