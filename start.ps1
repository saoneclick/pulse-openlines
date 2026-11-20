# ПУЛЬС — локальный запуск в фоне (Windows)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot

$port = 8090
$pidFile = Join-Path $PSScriptRoot "data\server.pid"

if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
        Write-Host "ПУЛЬС уже запущен (PID $old): http://127.0.0.1:$port"
        exit 0
    }
}

if (-not (Test-Path ".venv")) {
    Write-Host "Создаю виртуальное окружение..."
    python -m venv .venv
}

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
Write-Host "Проверяю зависимости..."
& $python -m pip install -q -r requirements.txt

New-Item -ItemType Directory -Force data | Out-Null

$proc = Start-Process -FilePath $python `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$port" `
    -RedirectStandardOutput "data\server.out.log" `
    -RedirectStandardError "data\server.err.log" `
    -WindowStyle Hidden -PassThru

$proc.Id | Set-Content $pidFile -Encoding ascii
Start-Sleep -Seconds 2

try {
    $health = Invoke-RestMethod "http://127.0.0.1:$port/api/health"
    Write-Host "ПУЛЬС запущен: http://127.0.0.1:$port  (PID $($proc.Id))"
} catch {
    Write-Host "Сервер не ответил. Смотрите data\server.err.log"
    Get-Content "data\server.err.log" -Tail 20
}
