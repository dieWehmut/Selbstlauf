# Guards on the release workflow itself.
#
# Written after v0.8.4 failed its `package` job for a reason that had nothing to do with the
# artefact: the in-place upgrade check called the GitHub API WITHOUT a token, hit the anonymous
# rate limit (60 requests per hour per IP, shared by the runners) and aborted. Every installer had
# already been verified by then, so a release was failed by its own last step.
#
# Two properties are therefore pinned here: any api.github.com call is authenticated, and a step
# whose only job is an optional extra check does not fail the release when it cannot run.
[CmdletBinding()]
param()

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

Write-Host 'release workflow'

$workflowDirectory = Join-Path $script:RepositoryRoot '.github\workflows'
$workflows = Get-ChildItem -LiteralPath $workflowDirectory -Filter '*.yml' -ErrorAction SilentlyContinue
Assert-True ($workflows.Count -gt 0) 'at least one workflow exists'

$allCallsAuthenticated = $true
$rateLimitGuarded = $true
$foundApiCall = $false

foreach ($workflow in $workflows) {
    $text = Get-Content -LiteralPath $workflow.FullName -Raw
    $lines = $text -split "`r?`n"

    for ($index = 0; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        if ($line -notmatch 'api\.github\.com') { continue }
        # A comment mentioning the API is not a call.
        if ($line.TrimStart().StartsWith('#')) { continue }
        if ($line -notmatch 'Invoke-RestMethod|Invoke-WebRequest|curl|gh api') { continue }
        $foundApiCall = $true

        # The token must be supplied by the STEP that makes the call, found by walking back to the
        # step's own `- name:` and reading forward from there. An earlier version of this check
        # looked at a fixed 30-line window and passed even after the token was deleted, because the
        # script body still mentioned `$env:GH_TOKEN` further down — a mention is not a declaration.
        $stepStart = $index
        while ($stepStart -gt 0 -and $lines[$stepStart] -notmatch '^\s*-\s+name:') { $stepStart-- }
        $stepText = ($lines[$stepStart..$index] -join "`n")
        $declaresToken = $stepText -match '(?m)^\s+GH_TOKEN:\s*\S+'
        if (-not $declaresToken) {
            Write-Host "    $($workflow.Name):$($index + 1) is in a step that does not declare GH_TOKEN"
            $allCallsAuthenticated = $false
        }
    }

    # An API call that can abort the step should be inside a try/catch: the artefacts are already
    # verified by then, so a 403 must not fail the release.
    if ($text -match 'api\.github\.com' -and $text -notmatch 'catch\s*\{') {
        Write-Host "    $($workflow.Name) calls the API with no try/catch"
        $rateLimitGuarded = $false
    }
}

Assert-True $foundApiCall 'the workflow check actually found an api.github.com call to inspect'
Assert-True $allCallsAuthenticated 'every api.github.com call is authenticated (the anonymous limit is 60/hour)'
Assert-True $rateLimitGuarded 'an api.github.com failure is caught rather than failing the release'

# A step that exists only to add confidence must not be able to fail the build on its own
# inability to run: both of its skip paths must exit 0.
$release = Get-Content -LiteralPath (Join-Path $workflowDirectory 'release-desktop.yml') -Raw
Assert-True ($release -match 'skipping the in-place upgrade check') 'the upgrade check still reports when it is skipped'
$skipExits = ([regex]::Matches($release, 'skipping the in-place upgrade check[\s\S]{0,400}?exit 0')).Count
Assert-True ($skipExits -ge 2) "both skip paths exit 0 (found $skipExits)"

Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) release workflow check(s) failed."
    exit 1
}
Write-Host 'All release workflow checks passed.'