# ПУЛЬС — остановка локального сервера
$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot

$stopped = @()
$pidFile = Join-Path $PSScriptRoot "data\server.pid"

if (Test-Path $pidFile) {
    $serverPid = Get-Content $pidFile
    if ($serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $serverPid -Force
        $stopped += $serverPid
    }
    Remove-Item $pidFile -Force
}

# Uvicorn может оставить дочерний процесс — гасим всё, что слушает порт.
$connections = Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $connections) {
    $listener = $conn.OwningProcess
    if ($listener -and $listener -ne $PID -and $stopped -notcontains $listener) {
        Stop-Process -Id $listener -Force
        $stopped += $listener
    }
}

if ($stopped.Count -gt 0) {
    Write-Host "ПУЛЬС остановлен (PID: $($stopped -join ', '))"
} else {
    Write-Host "ПУЛЬС не запущен"
}
