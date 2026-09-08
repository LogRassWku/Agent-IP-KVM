$ErrorActionPreference = 'Stop'

$KvmUrl = __KVM_URL__
$PairingToken = __PAIRING_TOKEN__
$TaskId = __TASK_ID__
$Model = __MODEL__
$InstallDir = __INSTALL_DIR__
$ModelsDir = __MODELS_DIR__

function Send-Progress {
    param([string]$Status, [int]$Progress, [string]$Message)
    $headers = @{ Authorization = "Bearer $PairingToken" }
    $body = @{ task_id = $TaskId; status = $Status; progress = $Progress; message = $Message } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Uri "$KvmUrl/api/model-setup/progress" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
    } catch {
        # Installation continues if a transient link issue prevents one progress update.
    }
}

try {
    Send-Progress 'downloading_runtime' 8 '正在下载 Ollama 官方安装程序'
    New-Item -ItemType Directory -Force -Path $InstallDir, $ModelsDir | Out-Null
    [Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $ModelsDir, 'User')
    $env:OLLAMA_MODELS = $ModelsDir
    $env:OLLAMA_INSTALL_DIR = $InstallDir

    $installerScript = Join-Path $env:TEMP 'agent-ip-kvm-ollama-install.ps1'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://ollama.com/install.ps1' -OutFile $installerScript
    Send-Progress 'installing_runtime' 24 '正在静默安装 Ollama（官方安装器会校验程序签名）'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installerScript

    $ollama = Join-Path $InstallDir 'ollama.exe'
    if (-not (Test-Path $ollama)) {
        $candidate = Get-Command ollama.exe -ErrorAction SilentlyContinue
        if ($candidate) { $ollama = $candidate.Source }
    }
    if (-not (Test-Path $ollama)) { throw 'Ollama 安装完成后未找到 ollama.exe' }

    Send-Progress 'downloading_model' 38 "正在下载 $Model，所需时间取决于网络速度"
    $lastPullPercent = -1
    & $ollama pull $Model 2>&1 | ForEach-Object {
        $line = $_.ToString()
        if ($line -match '(?<percent>\d{1,3})%') {
            $pullPercent = [Math]::Min(100, [int]$Matches['percent'])
            if ($pullPercent -ne $lastPullPercent) {
                $lastPullPercent = $pullPercent
                $taskProgress = 38 + [Math]::Floor($pullPercent * 0.54)
                Send-Progress 'downloading_model' $taskProgress "正在下载 $Model（$pullPercent%）"
            }
        }
        Write-Output $line
    }
    $pullExitCode = $LASTEXITCODE
    if ($pullExitCode -ne 0) { throw "模型下载失败，退出代码 $pullExitCode" }

    Send-Progress 'verifying' 94 '正在校验模型清单'
    $tagsUri = 'http://127.0.0.1:11434/api/tags'
    try {
        Invoke-RestMethod -Uri $tagsUri -Method Get -TimeoutSec 5 | Out-Null
    } catch {
        # The Windows installer normally starts Ollama. If it did not, start a
        # private background daemon so the local API and model are usable.
        Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
        $ready = $false
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            Start-Sleep -Seconds 1
            try { Invoke-RestMethod -Uri $tagsUri -Method Get -TimeoutSec 3 | Out-Null; $ready = $true; break } catch { }
        }
        if (-not $ready) { throw 'Ollama 本地 API 未能启动' }
    }
    $models = (& $ollama list | Out-String)
    if ($LASTEXITCODE -ne 0 -or $models -notmatch [regex]::Escape(($Model -split ':')[0])) {
        throw '模型下载后校验失败'
    }
    Send-Progress 'completed' 100 "$Model 已安装到 $ModelsDir"
} catch {
    Send-Progress 'failed' 100 ("配置失败：" + $_.Exception.Message)
    throw
}
