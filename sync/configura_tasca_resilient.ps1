$ErrorActionPreference = "Stop"

$taskName = "MT5-Supabase-Sync"
$syncDir = $PSScriptRoot
$scriptPath = Join-Path $syncDir "sync_mt5_to_supabase.py"
$runnerPath = Join-Path $syncDir "run_supabase_sync.ps1"
$userId = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $scriptPath)) {
    throw "No existeix el sincronitzador: $scriptPath"
}
if (-not (Test-Path $runnerPath)) {
    throw "No existeix el runner: $runnerPath"
}

$pythonPath = (& py -3 -c "import sys; print(sys.executable)").Trim()
if (-not $pythonPath -or -not (Test-Path $pythonPath)) {
    throw "No s'ha trobat Python 3."
}

& $pythonPath -m py_compile $scriptPath
if ($LASTEXITCODE -ne 0) {
    throw "El sincronitzador no supera py_compile."
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerPath`"" `
    -WorkingDirectory $syncDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId

$principal = New-ScheduledTaskPrincipal `
    -UserId $userId `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Sincronitzacio resilient i de nomes lectura entre MT5 i Supabase." `
    -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 10

$task = Get-ScheduledTask -TaskName $taskName
if ($task.State -ne "Running") {
    throw "La tasca no ha quedat Running. Estat: $($task.State)"
}

Write-Host "Tasca '$taskName' configurada i en execucio."
Write-Host "No s'ha modificat el fitxer .env ni s'ha enviat cap ordre a MT5."
