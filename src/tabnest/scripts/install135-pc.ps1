# Silent install TabNest 1.3.5 on the PC (run from GrokBot-Apps\TabNest)
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\Administrator\GrokBot-Apps\TabNest'
$setup = Join-Path $root 'TabNest-1.3.5-win-x64.exe'
$exe = 'C:\Users\Administrator\AppData\Local\Programs\TabNest\TabNest.exe'
Get-Process TabNest -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath $setup -ArgumentList '/S' -Wait
Start-Sleep -Seconds 2
if (-not (Test-Path $exe)) { throw "Install failed: missing $exe" }
$ver = (Get-Item $exe).VersionInfo.ProductVersion
Write-Output "Installed version: $ver"
Start-Process $exe
