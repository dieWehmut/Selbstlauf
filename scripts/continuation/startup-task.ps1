[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)

# schtasks-compatible front end for the per-user logon task.
#
# schtasks.exe refuses "/SC ONLOGON" for a non-elevated account ("Access is
# denied"), while the ScheduledTasks cmdlets register the same per-user task
# without elevation. This helper accepts the schtasks arguments the callers
# already build, so the watchdog can own a logon task for the current user only.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$taskName = 'Selbstlauf Continuation Watchdog'
$operation = $null
$action = $null
$force = $false

for ($index = 0; $index -lt $Arguments.Count; $index++) {
    $token = $Arguments[$index]
    switch -Regex ($token) {
        '^/(Query|Create|Delete)$' { $operation = $Matches[1].ToLowerInvariant(); continue }
        '^/(TN|TR)$' {
            if ($index + 1 -ge $Arguments.Count) { throw "missing value for $token" }
            $value = $Arguments[$index + 1]
            if ($token -ieq '/TN') { $taskName = $value } else { $action = $value }
            $index++
            continue
        }
        '^/(SC|RL)$' {
            if ($index + 1 -ge $Arguments.Count) { throw "missing value for $token" }
            $value = $Arguments[$index + 1]
            if ($token -ieq '/SC' -and $value -ine 'ONLOGON') { throw "unsupported schedule type '$value'" }
            if ($token -ieq '/RL' -and $value -inotin @('LIMITED', 'HIGHEST')) { throw "unsupported run level '$value'" }
            $index++
            continue
        }
        '^/F$' { $force = $true; continue }
        default { throw "unsupported argument '$token'" }
    }
}

if ([string]::IsNullOrWhiteSpace($operation)) { throw 'one of /Query, /Create or /Delete is required' }
if ([string]::IsNullOrWhiteSpace($taskName)) { throw '/TN requires a task name' }

function Get-OwnedTask {
    param([string]$Name)
    return Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}

function New-OwnedTask {
    param([string]$Name, [string]$Action, [bool]$Force)

    $existing = Get-OwnedTask -Name $Name
    if ($null -ne $existing -and -not $Force) {
        throw "scheduled task '$Name' already exists"
    }
    $user = "$env:USERDOMAIN\$env:USERNAME"
    # The watchdog runs a PowerShell command line, so the action is split into the
    # executable and its arguments the way the Task Scheduler stores them.
    $executable = 'powershell.exe'
    $commandLine = $Action.Trim()
    if ($commandLine.StartsWith('"')) {
        $closing = $commandLine.IndexOf('"', 1)
        if ($closing -lt 1) { throw 'the action has an unterminated quoted executable' }
        $executable = $commandLine.Substring(1, $closing - 1)
        $commandLine = $commandLine.Substring($closing + 1).Trim()
    }
    elseif ($commandLine -match '^(?<exe>\S+)\s*(?<rest>.*)$') {
        $executable = $Matches['exe']
        $commandLine = $Matches['rest'].Trim()
    }
    $taskAction = New-ScheduledTaskAction -Execute $executable -Argument $commandLine
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $Name -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Invoke-Operation {
    param([string]$Name, [string]$Action, [bool]$Force)

    switch ($operation) {
        'query' {
            if ($null -ne (Get-OwnedTask -Name $Name)) {
                Write-Output "SUCCESS: The scheduled task `"$Name`" exists."
                exit 0
            }
            [Console]::Error.WriteLine('ERROR: The system cannot find the file specified.')
            exit 1
        }
        'create' {
            if ([string]::IsNullOrWhiteSpace($Action)) { throw '/TR requires an action' }
            New-OwnedTask -Name $Name -Action $Action -Force $Force
            Write-Output "SUCCESS: The scheduled task `"$Name`" has successfully been created."
            exit 0
        }
        'delete' {
            $existing = Get-OwnedTask -Name $Name
            if ($null -eq $existing) {
                if ($Force) { Write-Output "SUCCESS: The scheduled task `"$Name`" did not exist."; exit 0 }
                throw "scheduled task '$Name' does not exist"
            }
            Unregister-ScheduledTask -TaskName $Name -Confirm:$false
            Write-Output "SUCCESS: The scheduled task `"$Name`" was successfully deleted."
            exit 0
        }
        default { throw "unsupported operation '$operation'" }
    }
}

Invoke-Operation -Name $taskName -Action $action -Force $force