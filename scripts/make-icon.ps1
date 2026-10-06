# Builds build/icon.ico for Windows from a source image or icon.
# Windows wants a square icon in several sizes; the source is centred on a
# transparent square and scaled down to each size.
#   powershell -File scripts/make-icon.ps1 -Source path\to\image.ico
param(
  [Parameter(Mandatory)] [string] $Source,
  [string] $Target = 'build/icon.ico'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngSignature = [byte[]](0x89, 0x50, 0x4E, 0x47)

function Read-SourceImage([string] $path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $isIcon = $bytes[0] -eq 0 -and $bytes[1] -eq 0 -and $bytes[2] -eq 1 -and $bytes[3] -eq 0
  if (-not $isIcon) { return [Drawing.Image]::FromStream((New-Object IO.MemoryStream (, $bytes))) }

  # Take the largest image of the icon.
  $count = [BitConverter]::ToUInt16($bytes, 4)
  $best = 0
  $bestWidth = 0
  for ($i = 0; $i -lt $count; $i++) {
    $width = $bytes[6 + 16 * $i]
    if ($width -eq 0) { $width = 256 }
    if ($width -gt $bestWidth) { $bestWidth = $width; $best = $i }
  }
  $entry = 6 + 16 * $best
  $length = [BitConverter]::ToUInt32($bytes, $entry + 8)
  $offset = [BitConverter]::ToUInt32($bytes, $entry + 12)
  $data = New-Object byte[] $length
  [Array]::Copy($bytes, $offset, $data, 0, $length)
  $isPng = -not (Compare-Object $data[0..3] $pngSignature)
  if ($isPng) { return [Drawing.Image]::FromStream((New-Object IO.MemoryStream (, $data))) }
  return (New-Object Drawing.Icon $path, 256, 256).ToBitmap()
}

$image = Read-SourceImage (Resolve-Path $Source)
$side = [Math]::Max($image.Width, $image.Height)
$square = New-Object Drawing.Bitmap $side, $side, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [Drawing.Graphics]::FromImage($square)
$graphics.Clear([Drawing.Color]::Transparent)
$graphics.DrawImage($image, [int](($side - $image.Width) / 2), [int](($side - $image.Height) / 2), $image.Width, $image.Height)
$graphics.Dispose()

$pngs = foreach ($size in $sizes) {
  $scaled = New-Object Drawing.Bitmap $size, $size, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($scaled)
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([Drawing.Color]::Transparent)
  $g.DrawImage($square, 0, 0, $size, $size)
  $g.Dispose()
  $stream = New-Object IO.MemoryStream
  $scaled.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
  , $stream.ToArray()
}

# ICO container: 6-byte header, one 16-byte entry per image, then the PNG data.
$out = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter $out
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
  $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$pngs[$i].Length); $writer.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($png in $pngs) { $writer.Write($png) }
$writer.Flush()

New-Item -ItemType Directory -Force (Split-Path $Target) | Out-Null
[IO.File]::WriteAllBytes((Join-Path (Get-Location) $Target), $out.ToArray())
# The largest size is also kept as a PNG, for places that cannot read .ico.
[IO.File]::WriteAllBytes((Join-Path (Get-Location) ($Target -replace '\.ico$', '.png')), $pngs[-1])
"wrote $Target with sizes $($sizes -join ', ') from a $($image.Width)x$($image.Height) source"
