param(
    [string[]]$IncludeExecutableName = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$includeNames = @(
    foreach ($configuredName in $IncludeExecutableName) {
        $normalizedName = ([string]$configuredName).Trim().Trim('"').Replace('/', '\\')
        if ($normalizedName.Length -gt 0) {
            $lastSeparator = $normalizedName.LastIndexOf('\\')
            $normalizedName.Substring($lastSeparator + 1).ToLowerInvariant()
        }
    }
)

function ConvertTo-NullableString {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) {
        return $null
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }
    return $text
}

function Resolve-OwnerSid {
    param([object]$Process)

    try {
        # GetOwnerSid is implemented by current Windows versions and avoids
        # a potentially blocking domain lookup for protected/system accounts.
        $ownerSid = $Process.GetOwnerSid()
        if ($null -ne $ownerSid -and $ownerSid.ReturnValue -eq 0 -and -not [string]::IsNullOrWhiteSpace($ownerSid.Sid)) {
            return [string]$ownerSid.Sid
        }
    } catch {
        # Fall through to GetOwner for older WMI providers.
    }

    try {
        # GetOwner is available in Windows PowerShell 5.1 and returns the
        # domain/user pair needed to translate the owner to a stable SID.
        $owner = $Process.GetOwner()
        if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($owner.User)) {
            return $null
        }

        $account = New-Object System.Security.Principal.NTAccount -ArgumentList @($owner.Domain, $owner.User)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}

$records = @(
    foreach ($process in Get-WmiObject -Class Win32_Process) {
        $processName = ConvertTo-NullableString $process.Name
        $processCommandLine = ConvertTo-NullableString $process.CommandLine
        $processBaseName = if ($null -eq $processName) {
            $null
        } else {
            $processName.Trim().ToLowerInvariant()
        }
        $candidate =
            ($processBaseName -match '^(?:node|codex|claude)(?:[-.]|$)') -or
            ($null -ne $processBaseName -and $includeNames -contains $processBaseName) -or
            $processCommandLine -match '(?i)(?:claude-code|claude\.ps1|@openai[\\/]codex|codex\.js|codex\.exe)'
        if (-not $candidate) {
            continue
        }

        [pscustomobject]@{
            pid = [int]$process.ProcessId
            parentPid = [int]$process.ParentProcessId
            name = $processName
            commandLine = $processCommandLine
            executablePath = ConvertTo-NullableString $process.ExecutablePath
            creationDate = ConvertTo-NullableString $process.CreationDate
            userSid = Resolve-OwnerSid $process
        }
    }
)

ConvertTo-Json -InputObject $records -Compress
