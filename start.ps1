# Start the trading desk in the foreground (Ctrl+C stops it).
#   pwsh start.ps1               npm ci / build only when needed, then http://127.0.0.1:<port from config.json, default 8095>
#   pwsh start.ps1 -Port 8096    other port
#   pwsh start.ps1 -Rebuild      rebuild the web app
# Data folder: $env:TRADEDESK_HOME or ~/.tradedesk (config.json, desk.sqlite).
param([int]$Port = 0, [switch]$Rebuild)
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

$lock = Join-Path $Root "package-lock.json"
$stamp = Join-Path $Root "node_modules\.package-lock.json"
if (-not (Test-Path $stamp) -or (Get-Item $lock).LastWriteTime -gt (Get-Item $stamp).LastWriteTime) {
	"npm ci ..."
	$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
	npm ci --no-audit --no-fund
	if ($LASTEXITCODE) { throw "npm ci failed" }
}

$dist = Join-Path $Root "apps\web\dist\index.html"
$newestSrc = Get-ChildItem (Join-Path $Root "apps\web\src"), (Join-Path $Root "packages\shared\src") -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($Rebuild -or -not (Test-Path $dist) -or $newestSrc.LastWriteTime -gt (Get-Item $dist).LastWriteTime) {
	"building the web app ..."
	npm run build
	if ($LASTEXITCODE) { throw "build failed" }
}

if ($Port) { node apps/server/src/index.ts --port $Port } else { node apps/server/src/index.ts }
