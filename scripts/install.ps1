# Installs the latest vibeshare.exe (client, provider and algorithm nodes in one file).
#   irm https://raw.githubusercontent.com/MabzGamesStudio/VibeShare/main/scripts/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Repo = 'MabzGamesStudio/VibeShare'
$Dest = if ($env:VIBESHARE_INSTALL_DIR) { $env:VIBESHARE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'VibeShare\bin' }
$Api = if ($env:VIBESHARE_VERSION) { "https://api.github.com/repos/$Repo/releases/tags/$($env:VIBESHARE_VERSION)" } else { "https://api.github.com/repos/$Repo/releases/latest" }

$release = Invoke-RestMethod -Uri $Api -Headers @{ 'User-Agent' = 'vibeshare-installer' }
$asset = $release.assets | Where-Object { $_.name -match '^vibeshare-.*-windows-x64\.exe$' } | Select-Object -First 1
if (-not $asset) { throw 'No Windows build in the release.' }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$target = Join-Path $Dest 'vibeshare.exe'
Write-Host "Downloading $($asset.browser_download_url)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $Dest })) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$Dest", 'User')
  Write-Host "Added $Dest to your PATH (open a new terminal)."
}
Write-Host "Installed $target"
Write-Host 'Try it:  vibeshare demo --open'
