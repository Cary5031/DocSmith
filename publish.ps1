# 產生單一執行檔 build\bin\DocSmith.exe
# 需求：Go 1.23+、Node.js 20.19+、wails CLI（go install github.com/wailsapp/wails/v2/cmd/wails@latest）
#
# 版本號以 version.json 為準（自動更新靠它判斷有無新版），建置時同步到 wails.json 的 productVersion。
# 發布新版：.\publish.ps1 -Version 1.1.0   → 同時更新 version.json 的 version 與 releaseDate
param(
    [string]$Version
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$utf8 = New-Object System.Text.UTF8Encoding $false
$versionFile = Join-Path $PSScriptRoot 'version.json'
$versionText = [IO.File]::ReadAllText($versionFile)
if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Write-Error "版本號格式應為 x.y.z：$Version"
    }
    $today = Get-Date -Format 'yyyy-MM-dd'
    $versionText = $versionText -replace '"version":\s*"[^"]*"', ('"version": "' + $Version + '"')
    $versionText = $versionText -replace '"releaseDate":\s*"[^"]*"', ('"releaseDate": "' + $today + '"')
    [IO.File]::WriteAllText($versionFile, $versionText, $utf8)
}
$Version = ($versionText | ConvertFrom-Json).version

$wailsFile = Join-Path $PSScriptRoot 'wails.json'
$wailsText = [IO.File]::ReadAllText($wailsFile)
$wailsText = $wailsText -replace '"productVersion":\s*"[^"]*"', ('"productVersion": "' + $Version + '"')
[IO.File]::WriteAllText($wailsFile, $wailsText, $utf8)
Write-Host "版本：$Version"

$wails = Get-Command wails -ErrorAction SilentlyContinue
if ($wails) {
    $wails = $wails.Source
} else {
    $wails = Join-Path $env:USERPROFILE 'go\bin\wails.exe'
    if (-not (Test-Path $wails)) {
        Write-Error '找不到 wails CLI，請先執行：go install github.com/wailsapp/wails/v2/cmd/wails@latest'
    }
}

& $wails build -clean -trimpath
if ($LASTEXITCODE -ne 0) {
    Write-Error "建置失敗（exit code $LASTEXITCODE）"
}

$exe = Join-Path $PSScriptRoot 'build\bin\DocSmith.exe'

# 把 exe 的 SHA-256 寫入 version.json，自動更新下載後用來驗證檔案
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
$versionText = [IO.File]::ReadAllText($versionFile)
if ($versionText -match '"sha256"') {
    $versionText = $versionText -replace '"sha256":\s*"[^"]*"', ('"sha256": "' + $hash + '"')
} else {
    $versionText = $versionText -replace '("downloadUrl":\s*"[^"]*")', ('$1,' + "`n" + '  "sha256": "' + $hash + '"')
}
[IO.File]::WriteAllText($versionFile, $versionText, $utf8)
$sizeMB = [Math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ''
Write-Host "完成：$exe（$sizeMB MB）" -ForegroundColor Green
