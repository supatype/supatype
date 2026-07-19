# Supatype CLI install for Windows (PowerShell)
# Usage: irm https://releases.supatype.com/install.ps1 | iex
# Or run locally: .\scripts\install-supatype.ps1

$ErrorActionPreference = "Stop"

$cdnBase = if ($env:SUPATYPE_CDN_BASE) { $env:SUPATYPE_CDN_BASE } else { "https://releases.supatype.com" }
$installDir = if ($env:SUPATYPE_INSTALL_DIR) { $env:SUPATYPE_INSTALL_DIR } else { "$env:USERPROFILE\.local\bin" }
$version = $env:SUPATYPE_VERSION

if (-not $version) {
  $latest = Invoke-RestMethod -Uri "$cdnBase/cli/latest.json"
  $version = $latest.version
}
if (-not $version) {
  throw "Could not resolve CLI version from $cdnBase/cli/latest.json"
}

$arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { throw "32-bit Windows is not supported" }
$url = "$cdnBase/cli/v$version/supatype-cli-windows-$arch.exe"
$dest = Join-Path $installDir "supatype.exe"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Write-Host "Installing supatype CLI v$version to $dest..."
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

Write-Host ""
Write-Host "Done. Add $installDir to your PATH, then:"
Write-Host "  supatype init my-app; cd my-app; pnpm install; supatype dev"
