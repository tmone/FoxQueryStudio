@echo off
rem FoxQuery Studio - tai ban moi nhat ve thu muc nay roi chay.
rem Chay lai bat cu luc nao: co ban moi thi tai, khong thi mo ban dang co.
rem Chuong trinh nam trong thu muc con FoxQueryStudio\ (dang giai nen san, mo trong khoang 1 giay).
rem Tuy chon: dat bien FQS_VFP_KIT_URL = dia chi noi bo cua vfp9.zip (Visual FoxPro 9) de tai kem.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$repo = 'tmone/FoxQueryStudio'; $dir = 'FoxQueryStudio'; $exe = Join-Path $dir 'FoxQuery Studio.exe'; $stamp = Join-Path $dir 'version.txt';" ^
  "Write-Host 'Kiem tra ban moi nhat cua FoxQuery Studio...';" ^
  "$release = Invoke-RestMethod -Uri \"https://api.github.com/repos/$repo/releases/latest\" -Headers @{ 'User-Agent' = 'FoxQueryStudio-start' };" ^
  "$zip = $release.assets | Where-Object { $_.name -like 'FoxQueryStudio-*.zip' } | Select-Object -First 1;" ^
  "if (-not $zip) { throw 'Ban phat hanh khong co thu muc chuong trinh (.zip).' }" ^
  "$have = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { '' };" ^
  "if ($have -ne $release.tag_name -or -not (Test-Path $exe)) {" ^
  "  Write-Host ('Tai ' + $zip.name + ' (' + [math]::Round($zip.size / 1MB) + ' MB)...');" ^
  "  Invoke-WebRequest -Uri $zip.browser_download_url -OutFile 'program.zip' -UseBasicParsing;" ^
  "  $hash = (Get-FileHash 'program.zip' -Algorithm SHA256).Hash.ToLower();" ^
  "  if ($zip.digest -and $zip.digest -ne ('sha256:' + $hash)) { Remove-Item 'program.zip'; throw 'Tep tai ve khong khop ma kiem tra SHA-256.' }" ^
  "  if (Test-Path ($dir + '.new')) { Remove-Item ($dir + '.new') -Recurse -Force }" ^
  "  Expand-Archive 'program.zip' -DestinationPath ($dir + '.new') -Force; Remove-Item 'program.zip';" ^
  "  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }" ^
  "  Rename-Item ($dir + '.new') $dir;" ^
  "  Set-Content -Path $stamp -Value $release.tag_name -Encoding ascii;" ^
  "} else { Write-Host ('Da co ban moi nhat: ' + $release.tag_name) }" ^
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
  "Start-Process -FilePath (Resolve-Path $exe);"
if errorlevel 1 (
  echo.
  echo Khong tai duoc. Kiem tra ket noi mang roi chay lai start.cmd.
  pause
)
endlocal
