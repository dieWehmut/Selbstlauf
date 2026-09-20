# The version must be consistent everywhere it is declared.
#
# A failed version bump once left v0.2.8 tagged while apps/desktop and apps/web still
# declared 0.2.7. CI, which had no guard, then built and uploaded
# `Selbstlauf-Setup-0.2.7-x64.exe` onto the v0.2.8 release — a file that was not the
# real 0.2.7 either, so anyone downloading "0.2.7" from that page got neither version.
#
# This keeps the three declarations in step, and (when given a tag) checks the tag
# agrees with them, which is the check CI was missing.
[CmdletBinding()]
param(
    # The release tag being published, e.g. 'v0.2.8'. Optional: without it only the
    # three in-repo declarations are compared.
    [string]$Tag
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:RepositoryRoot = Split-Path -Parent $PSScriptRoot
$script:Failures = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($Condition) {
        Write-Host "  ok   $Message"
    } else {
        Write-Host "  FAIL $Message"
        $script:Failures += 1
    }
}

function Get-PackageVersion {
    param([string]$RelativePath)
    $full = Join-Path $script:RepositoryRoot $RelativePath
    if (-not (Test-Path -LiteralPath $full)) { throw "missing $RelativePath" }
    $json = Get-Content -LiteralPath $full -Raw | ConvertFrom-Json
    return [string]$json.version
}

Write-Host 'version consistency'

$desktop = Get-PackageVersion 'apps\desktop\package.json'
$web = Get-PackageVersion 'apps\web\package.json'

# The renderer shows this in the account section, so it is user-visible.
$appSource = Get-Content -LiteralPath (Join-Path $script:RepositoryRoot 'apps\web\src\App.tsx') -Raw
$appMatch = [regex]::Match($appSource, "const APP_VERSION = '([^']+)'")
if (-not $appMatch.Success) { throw 'APP_VERSION not found in apps/web/src/App.tsx' }
$app = $appMatch.Groups[1].Value

Write-Host "  apps/desktop/package.json : $desktop"
Write-Host "  apps/web/package.json     : $web"
Write-Host "  App.tsx APP_VERSION       : $app"

Assert-True ($desktop -eq $web) 'the two workspace manifests declare the same version'
Assert-True ($desktop -eq $app) 'APP_VERSION matches the workspace version'

# The lockfile records both workspace versions and must not lag behind. It is read
# with a regex rather than ConvertFrom-Json because its keys contain slashes
# ("apps/desktop"), which Windows PowerShell's JSON parser rejects as property names.
$lockRaw = Get-Content -LiteralPath (Join-Path $script:RepositoryRoot 'package-lock.json') -Raw
function Get-LockVersion {
    param([string]$Workspace)
    $pattern = '"' + [regex]::Escape($Workspace) + '"\s*:\s*\{[^}]*?"version"\s*:\s*"([^"]+)"'
    $m = [regex]::Match($lockRaw, $pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $m.Success) { throw "package-lock.json has no version for $Workspace" }
    return $m.Groups[1].Value
}
$lockDesktop = Get-LockVersion 'apps/desktop'
$lockWeb = Get-LockVersion 'apps/web'
Write-Host "  package-lock.json         : $lockDesktop / $lockWeb"
Assert-True ($lockDesktop -eq $desktop) 'the lockfile records the desktop version'
Assert-True ($lockWeb -eq $web) 'the lockfile records the web version'

# A version that is not a plain semver will not make a usable artifact name.
Assert-True ($desktop -match '^\d+\.\d+\.\d+$') "the version '$desktop' is a plain semver triple"

if ($Tag) {
    Write-Host ''
    Write-Host "tag check: $Tag"
    # Release tags are 'v' plus the version; anything else produces a mislabeled asset.
    Assert-True ($Tag -eq "v$desktop") "the tag '$Tag' matches the declared version 'v$desktop'"
    if ($Tag -ne "v$desktop") {
        Write-Host ''
        Write-Host '  Refusing to publish: CI would build an installer named after the package'
        Write-Host "  version ($desktop) and attach it to the $Tag release."
    }
}

Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) version consistency check(s) failed."
    exit 1
}
Write-Host 'All version consistency checks passed.'
exit 0