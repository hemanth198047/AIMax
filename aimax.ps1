# Starts everything AImax needs (checks/repairs packages, frees nothing unless -Force, starts Ollama if installed, opens the browser).
#   .\aimax.ps1            normal start
#   .\aimax.ps1 -Force     stop whatever is already using AImax's ports first
#   .\aimax.ps1 -Reinstall delete node_modules and install again
#   .\aimax.ps1 -Stop     stop a running AImax (from any window)
Param([switch]$Stop, [switch]$Force, [switch]$Reinstall, [switch]$NoOpen, [switch]$NoOllama, [switch]$Check)
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20 or newer is required but was not found. Install the LTS from https://nodejs.org, then run this again." -ForegroundColor Red
  exit 1
}
$a = @()
if ($Stop) { $a += '--stop' }
if ($Force) { $a += '--force' }; if ($Reinstall) { $a += '--reinstall' }; if ($NoOpen) { $a += '--no-open' }
if ($NoOllama) { $a += '--no-ollama' }; if ($Check) { $a += '--check' }
node scripts/aimax-start.mjs @a
exit $LASTEXITCODE
