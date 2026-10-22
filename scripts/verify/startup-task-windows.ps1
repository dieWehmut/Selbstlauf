param(
  [string]$Repository = "$env:LOCALAPPDATA\Temp\selbstlauf-verify\repo-win",
  [string]$Evidence = "$env:LOCALAPPDATA\Temp\selbstlauf-startup-task-verification-20261023"
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$taskName = 'Selbstlauf Settings Verification ' + [Guid]::NewGuid().ToString('N')
$userTaskName = 'Selbstlauf Continuation Watchdog'
$helper = "$Repository\scripts\continuation\startup-task.ps1"
$startScript = "$Repository\scripts\continuation\start-watchdog.ps1"
$scratch = Join-Path $env:TEMP ('selbstlauf-startup-' + [Guid]::NewGuid().ToString('N'))
$nativeShell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$notes = [System.Collections.Generic.List[string]]::new()

function Get-UserTaskXml {
  if (Get-ScheduledTask -TaskName $userTaskName -ErrorAction SilentlyContinue) {
    return Export-ScheduledTask -TaskName $userTaskName
  }
  return $null
}
function Invoke-Helper([string[]]$Arguments) {
  & $nativeShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Scheduled-task helper failed: $LASTEXITCODE" }
}
function Check([bool]$Condition, [string]$Label) {
  if (-not $Condition) { throw $Label }
  $notes.Add($Label)
  Write-Output "PASS $Label"
}

$userTaskBefore = Get-UserTaskXml
$userConfig = "$env:LOCALAPPDATA\ai-cli-bypass\continuation\config.json"
$userConfigBefore = if (Test-Path $userConfig) { (Get-FileHash $userConfig).Hash } else { $null }
$created = $false
New-Item -ItemType Directory -Path $scratch | Out-Null
New-Item -ItemType Directory -Path $Evidence -Force | Out-Null
try {
  # If an unexpected login occurs during the brief verification, the action can
  # only start a dry-run service using this disposable state, never user state.
  $wrapper = Join-Path $scratch 'isolated-start.ps1'
  $escapedState = $scratch.Replace("'", "''")
  $escapedStart = $startScript.Replace("'", "''")
  @"
`$env:LOCALAPPDATA = '$escapedState'
& '$escapedStart' -Port 0 -DryRun -NoBuild
"@ | Set-Content -LiteralPath $wrapper -Encoding UTF8
  $action = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wrapper + '"'
  Check (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) 'the verification task name does not replace an existing task'
  Invoke-Helper -Arguments @('/Create', '/TN', $taskName, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', $action)
  $created = $true
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  Invoke-Helper -Arguments @('/Query', '/TN', $taskName)
  $task = Get-ScheduledTask -TaskName $taskName
  $xml = Export-ScheduledTask -TaskName $taskName
  $xml | Set-Content "$Evidence\temporary-task.xml" -Encoding UTF8
  Check ($task.State -eq 'Disabled') 'the temporary logon task is disabled before inspection'
  Check ($task.Actions[0].Execute -eq 'powershell.exe' -and $task.Actions[0].Arguments.Contains($wrapper)) 'the registered action preserves the quoted disposable launcher path'
  Check ($task.Principal.RunLevel -eq 0 -and $task.Principal.LogonType -eq 3) 'the real scheduler uses limited interactive user permissions'
  Check ($task.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'the real scheduler stores a logon trigger'
  Invoke-Helper -Arguments @('/Delete', '/TN', $taskName, '/F')
  $created = $false
  Check (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) 'the helper removes its temporary task'
  $userTaskAfter = Get-UserTaskXml
  $userConfigAfter = if (Test-Path $userConfig) { (Get-FileHash $userConfig).Hash } else { $null }
  Check ($userTaskBefore -ceq $userTaskAfter) 'the actual user startup task is unchanged'
  Check ($userConfigBefore -ceq $userConfigAfter) 'the actual user continuation configuration is unchanged'
  [ordered]@{ ok = $true; temporaryTask = $taskName; action = $action; notes = $notes;
    userTaskPreserved = $true; userConfigBefore = $userConfigBefore; userConfigAfter = $userConfigAfter;
    helper = $helper } | ConvertTo-Json -Depth 6 | Set-Content "$Evidence\result.json" -Encoding UTF8
} finally {
  if ($created) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $scratch -Recurse -Force
}
