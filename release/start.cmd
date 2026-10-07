@echo off
rem FoxQuery Studio - tai ban moi nhat ve thu muc nay roi chay.
rem Chay lai bat cu luc nao: co ban moi thi tai, khong thi mo ban dang co.
rem Tuy chon: dat bien FQS_VFP_KIT_URL = dia chi noi bo cua vfp9.zip (Visual FoxPro 9) de tai kem.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$repo = 'tmone/FoxQueryStudio';" ^
  "Write-Host 'Kiem tra ban moi nhat cua FoxQuery Studio...';" ^
  "$release = Invoke-RestMethod -Uri \"https://api.github.com/repos/$repo/releases/latest\" -Headers @{ 'User-Agent' = 'FoxQueryStudio-start' };" ^
  "$exe = $release.assets | Where-Object { $_.name -like 'FoxQueryStudio-*.exe' } | Select-Object -First 1;" ^
  "if (-not $exe) { throw 'Ban phat hanh khong co tep chuong trinh.' }" ^
  "if (-not (Test-Path $exe.name)) {" ^
  "  Write-Host ('Tai ' + $exe.name + ' (' + [math]::Round($exe.size / 1MB) + ' MB)...');" ^
  "  Invoke-WebRequest -Uri $exe.browser_download_url -OutFile ($exe.name + '.part') -UseBasicParsing;" ^
  "  $hash = (Get-FileHash ($exe.name + '.part') -Algorithm SHA256).Hash.ToLower();" ^
  "  if ($exe.digest -and $exe.digest -ne ('sha256:' + $hash)) { Remove-Item ($exe.name + '.part'); throw 'Tep tai ve khong khop ma kiem tra SHA-256.' }" ^
  "  Move-Item ($exe.name + '.part') $exe.name -Force;" ^
  "  Get-ChildItem 'FoxQueryStudio-*.exe' | Where-Object { $_.Name -ne $exe.name } | Remove-Item -Force;" ^
  "} else { Write-Host ('Da co ban moi nhat: ' + $exe.name) }" ^
  "foreach ($name in 'FoxQueryStudio.config.json') {" ^
  "  $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1;" ^
  "  if ($asset -and -not (Test-Path $name)) { Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $name -UseBasicParsing }" ^
  "}" ^
  "$sample = $release.assets | Where-Object { $_.name -eq 'northwind-sample.zip' } | Select-Object -First 1;" ^
  "if ($sample -and -not (Test-Path 'northwind')) {" ^
  "  Write-Host 'Tai CSDL FoxPro mau (northwind)...';" ^
  "  Invoke-WebRequest -Uri $sample.browser_download_url -OutFile 'northwind-sample.zip' -UseBasicParsing;" ^
  "  Expand-Archive 'northwind-sample.zip' -DestinationPath 'northwind' -Force; Remove-Item 'northwind-sample.zip';" ^
  "}" ^
  "if ($env:FQS_VFP_KIT_URL -and -not (Test-Path 'vfp9\vfp9.exe')) {" ^
  "  Write-Host 'Tai Visual FoxPro 9 tu dia chi noi bo...';" ^
  "  Invoke-WebRequest -Uri $env:FQS_VFP_KIT_URL -OutFile 'vfp9.zip' -UseBasicParsing;" ^
  "  Expand-Archive 'vfp9.zip' -DestinationPath 'vfp9' -Force; Remove-Item 'vfp9.zip';" ^
  "}" ^
  "if (-not (Test-Path 'vfp9\vfp9.exe')) { Write-Host 'Chua co vfp9\vfp9.exe: mo CSDL FoxPro se can chon duong dan Visual FoxPro 9 (menu Ket noi).' }" ^
  "Start-Process -FilePath (Resolve-Path $exe.name);"
if errorlevel 1 (
  echo.
  echo Khong tai duoc. Kiem tra ket noi mang roi chay lai start.cmd.
  pause
)
endlocal
