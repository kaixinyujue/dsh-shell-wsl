# Install the wsl-container agent preset into $DSH_HOME/.agent-presets.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-preset.ps1 [-SetDefault]
#   -SetDefault   also set the preset as the default for future web sessions
#                 (patches the agent-presets row of the web profile patch).
param(
  [switch]$SetDefault
)

$ErrorActionPreference = "Stop"
$presetDir = Join-Path $PSScriptRoot "..\presets\wsl-container"
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$target = Join-Path $dshHome ".agent-presets\wsl-container"

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $presetDir "preset.yml") (Join-Path $target "preset.yml") -Force
Copy-Item (Join-Path $presetDir "agent.cordis.yml") (Join-Path $target "agent.cordis.yml") -Force
Write-Host "preset installed -> $target"

if (-not $SetDefault) {
  Write-Host ""
  Write-Host "To make it the default for new sessions, either:"
  Write-Host "  * Web UI: Settings -> General -> default agent preset -> 'WSL 容器模式', or"
  Write-Host "  * rerun this script with -SetDefault, which appends the patch below to"
  Write-Host "    $dshHome\profiles\web\cordis.patch.yml"
  return
}

$profilePatch = Join-Path $dshHome "profiles\web\cordis.patch.yml"
New-Item -ItemType Directory -Force -Path (Split-Path $profilePatch) | Out-Null
$snippet = @"

- id: agent-presets
  config:
    default: wsl-container
"@
if (Test-Path $profilePatch) {
  $existing = [System.IO.File]::ReadAllText($profilePatch)
  if ($existing -match "id: agent-presets") {
    Write-Warning "agent-presets row already exists in $profilePatch; edit its config.default to 'wsl-container' by hand."
  } else {
    $trimmed = $existing.TrimEnd()
    if ($trimmed.EndsWith("[]")) {
      # The profile template leaves an empty-array placeholder: replace the
      # trailing [] with the row instead of appending after it (which would
      # produce invalid patch YAML).
      $content = $trimmed.Substring(0, $trimmed.Length - 2) + $snippet + [Environment]::NewLine
      [System.IO.File]::WriteAllText($profilePatch, $content)
    } else {
      [System.IO.File]::AppendAllText($profilePatch, $snippet)
    }
    Write-Host "default preset set in $profilePatch"
  }
} else {
  [System.IO.File]::WriteAllText($profilePatch, $snippet)
  Write-Host "default preset set in $profilePatch"
}
