<#
.SYNOPSIS
    Regenerates every shipped Selbstlauf icon asset from a single square source image.

.DESCRIPTION
    Derives all desktop/web icon assets from one high-resolution source PNG using only
    built-in .NET / GDI+ (System.Drawing). No third-party tooling is required.

    Outputs (all paths are relative to -RepositoryRoot):
      apps/desktop/build/icon.ico            multi-frame ICO (16,24,32,48,64,128,256), PNG-compressed frames
      apps/web/public/favicon-32.png         32x32
      apps/web/public/apple-touch-icon.png   180x180
      apps/web/public/icon.png               512x512
      apps/web/src/assets/brand.png          256x256

    The script is idempotent: re-running it overwrites the outputs with identical bytes.
    It exits non-zero (with a clear message) when the source image is missing/unreadable.

.PARAMETER Source
    Path to the source image. Must exist and be decodable by GDI+.
    Defaults to assets/selbstlauf-icon-source.png, which is checked in so the
    assets can be regenerated on a machine that never saw the original file.

.PARAMETER RepositoryRoot
    Repository root that contains apps/desktop and apps/web. Defaults to the repository
    that contains this script (two levels above $PSScriptRoot).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\desktop\generate-icon-assets.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\desktop\generate-icon-assets.ps1 -Source D:\art\logo.png
#>
[CmdletBinding()]
param(
    [string]$Source = '',
    [string]$RepositoryRoot = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$IcoFrameSizes = @(16, 24, 32, 48, 64, 128, 256)
$PngTargets = @(
    [pscustomobject]@{ RelativePath = 'apps\web\public\favicon-32.png';       Size = 32  },
    [pscustomobject]@{ RelativePath = 'apps\web\public\apple-touch-icon.png'; Size = 180 },
    [pscustomobject]@{ RelativePath = 'apps\web\public\icon.png';             Size = 512 },
    [pscustomobject]@{ RelativePath = 'apps\web\src\assets\brand.png';        Size = 256 }
)
$IcoRelativePath = 'apps\desktop\build\icon.ico'
# The original artwork is checked in, so regeneration never depends on a file
# that only exists on one person's machine.
$DefaultSourceRelativePath = 'assets\selbstlauf-icon-source.png'

function Write-Failure {
    param([string]$Message, [int]$Code)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit $Code
}

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        Write-Failure -Message 'Cannot resolve the repository root: $PSScriptRoot is empty. Pass -RepositoryRoot explicitly.' -Code 10
    }
    $RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$RepositoryRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)

Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Reset-TargetFile {
    <# Ensures the parent directory exists, clears the read-only flag and deletes
       any stale file so the run is fully idempotent. #>
    param([string]$Path)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if ($item.IsReadOnly) { $item.IsReadOnly = $false }
        Remove-Item -LiteralPath $Path -Force
    }
}

function New-ScaledBitmap {
    <# Returns a fresh 32bppArgb bitmap of $Size x $Size rendered from the source.
       The source is centre-cropped to a square first, so the aspect ratio can never
       be distorted, then resampled with the highest-quality GDI+ settings.
       TileFlipXY avoids the edge ghosting that plain bicubic produces at the borders. #>
    param(
        [System.Drawing.Image]$SourceImage,
        [int]$Size
    )

    $side = [Math]::Min($SourceImage.Width, $SourceImage.Height)
    $srcX = [int][Math]::Floor(($SourceImage.Width  - $side) / 2)
    $srcY = [int][Math]::Floor(($SourceImage.Height - $side) / 2)

    $dest = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $dest.SetResolution(96, 96)

    $graphics = [System.Drawing.Graphics]::FromImage($dest)
    $attributes = New-Object System.Drawing.Imaging.ImageAttributes
    try {
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)

        $destRect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
        $graphics.DrawImage(
            $SourceImage,
            $destRect,
            $srcX, $srcY, $side, $side,
            [System.Drawing.GraphicsUnit]::Pixel,
            $attributes)
    }
    finally {
        $attributes.Dispose()
        $graphics.Dispose()
    }

    return $dest
}

function Get-PngBytes {
    <# Encodes an in-memory bitmap as a PNG byte array. #>
    param([System.Drawing.Bitmap]$Bitmap)
    $stream = New-Object System.IO.MemoryStream
    try {
        $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return $stream.ToArray()
    }
    finally {
        $stream.Dispose()
    }
}

function Write-PngAsset {
    <# Renders one square PNG asset and prints its one-line summary. #>
    param(
        [System.Drawing.Image]$SourceImage,
        [int]$Size,
        [string]$Path
    )
    Reset-TargetFile -Path $Path
    $bitmap = New-ScaledBitmap -SourceImage $SourceImage -Size $Size
    try {
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
    }
    $length = (Get-Item -LiteralPath $Path).Length
    Write-Host ("[png] {0}  {1} bytes  {2}x{2}" -f $Path, $length, $Size)
    return $length
}

function Write-IcoAsset {
    <# Builds a real multi-image ICO container.

       Layout: ICONDIR (6 bytes) + ICONDIRENTRY[N] (16 bytes each) + frame payloads.
       Every frame payload is a complete PNG stream, which Windows Vista+ and
       electron-builder both accept.
         ICONDIR:      reserved=0 (uint16), type=1 (uint16), count=N (uint16)
         ICONDIRENTRY: width (byte, 0 => 256), height (byte, 0 => 256),
                       colorCount=0 (byte), reserved=0 (byte),
                       planes=1 (uint16), bitCount=32 (uint16),
                       bytesInRes (uint32), imageOffset (uint32, absolute)
       All multi-byte fields are little-endian (BinaryWriter default). #>
    param(
        [System.Drawing.Image]$SourceImage,
        [int[]]$Sizes,
        [string]$Path
    )

    $payloads = New-Object 'System.Collections.Generic.List[byte[]]'
    foreach ($size in $Sizes) {
        $bitmap = New-ScaledBitmap -SourceImage $SourceImage -Size $size
        try {
            $payloads.Add((Get-PngBytes -Bitmap $bitmap))
        }
        finally {
            $bitmap.Dispose()
        }
    }

    $count = $Sizes.Count
    $offset = 6 + (16 * $count)   # ICONDIR header + all directory entries

    Reset-TargetFile -Path $Path

    $fileStream = [System.IO.File]::Create($Path)
    $writer = New-Object System.IO.BinaryWriter($fileStream)
    try {
        # ICONDIR
        $writer.Write([uint16]0)          # reserved
        $writer.Write([uint16]1)          # type: 1 = icon
        $writer.Write([uint16]$count)     # image count

        # ICONDIRENTRY per frame
        for ($i = 0; $i -lt $count; $i++) {
            $size = $Sizes[$i]
            $payload = $payloads[$i]
            # A dimension of 256 is encoded as 0 in the single-byte field.
            $dimension = if ($size -ge 256) { [byte]0 } else { [byte]$size }

            $writer.Write([byte]$dimension)         # width
            $writer.Write([byte]$dimension)         # height
            $writer.Write([byte]0)                  # colorCount (0 = truecolour)
            $writer.Write([byte]0)                  # reserved
            $writer.Write([uint16]1)                # planes
            $writer.Write([uint16]32)               # bitCount
            $writer.Write([uint32]$payload.Length)  # bytesInRes
            $writer.Write([uint32]$offset)          # imageOffset (absolute)

            $offset += $payload.Length
        }

        # Frame payloads, in the same order
        foreach ($payload in $payloads) {
            $writer.Write($payload)
        }
        $writer.Flush()
    }
    finally {
        $writer.Dispose()
        $fileStream.Dispose()
    }

    $length = (Get-Item -LiteralPath $Path).Length
    $sizeList = ($Sizes -join ',')
    Write-Host ("[ico] {0}  {1} bytes  {2} frames ({3})" -f $Path, $length, $count, $sizeList)
    return $length
}

# ---------------------------------------------------------------------------
# Validate the source
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Source)) {
    $Source = Join-Path $RepositoryRoot $DefaultSourceRelativePath
}
$Source = [System.IO.Path]::GetFullPath($Source)

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    Write-Failure -Message "source image not found: $Source" -Code 2
}

try {
    $sourceBytes = [System.IO.File]::ReadAllBytes($Source)
}
catch {
    Write-Failure -Message "source image could not be read: $Source ($($_.Exception.Message))" -Code 3
}
if ($null -eq $sourceBytes -or $sourceBytes.Length -eq 0) {
    Write-Failure -Message "source image is empty: $Source" -Code 3
}

$sourceStream = New-Object System.IO.MemoryStream(, $sourceBytes)
$sourceImage = $null
try {
    $sourceImage = [System.Drawing.Image]::FromStream($sourceStream)
}
catch {
    $sourceStream.Dispose()
    Write-Failure -Message "source image is not a decodable image: $Source ($($_.Exception.Message))" -Code 4
}

$totalBytes = 0
try {
    if ($sourceImage.Width -lt 1 -or $sourceImage.Height -lt 1) {
        Write-Failure -Message "source image has invalid dimensions: $Source" -Code 5
    }

    # The source is expected to be square; a non-square source is centre-cropped to a
    # square so that no output can ever be stretched.
    if ($sourceImage.Width -ne $sourceImage.Height) {
        Write-Host ("[warn] source is {0}x{1} (not square); centre-cropping to {2}x{2}" -f `
            $sourceImage.Width, $sourceImage.Height, [Math]::Min($sourceImage.Width, $sourceImage.Height))
    }

    Write-Host ("[src] {0}  {1} bytes  {2}x{3}  {4}" -f `
        $Source, $sourceBytes.Length, $sourceImage.Width, $sourceImage.Height, $sourceImage.PixelFormat)
    Write-Host ("[out] repository root: {0}" -f $RepositoryRoot)

    $icoPath = Join-Path $RepositoryRoot $IcoRelativePath
    $totalBytes += Write-IcoAsset -SourceImage $sourceImage -Sizes $IcoFrameSizes -Path $icoPath

    foreach ($target in $PngTargets) {
        $targetPath = Join-Path $RepositoryRoot $target.RelativePath
        $totalBytes += Write-PngAsset -SourceImage $sourceImage -Size $target.Size -Path $targetPath
    }

    Write-Host ("[done] 5 assets written, {0} bytes total" -f $totalBytes)
}
catch {
    Write-Failure -Message "asset generation failed: $($_.Exception.Message)" -Code 6
}
finally {
    if ($null -ne $sourceImage) { $sourceImage.Dispose() }
    $sourceStream.Dispose()
}

exit 0