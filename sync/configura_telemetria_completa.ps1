$ErrorActionPreference = "Stop"

$syncDir = $PSScriptRoot
$envPath = Join-Path $syncDir ".env"
$taskName = "MT5-Supabase-Sync"
$botDir = "C:\Users\Administrator\Desktop\BITGET_R2A_REAL_2500USD_730432938"
$botSource = Join-Path $botDir "bot_rr0109_spread_atr_012_grid225_cap007_fs350_demo.py"
$runtimeDir = Join-Path $botDir "runtime"
$newsFile = Join-Path $botDir "noticias_xau.csv"

if (-not (Test-Path $envPath)) {
    throw "No existeix el fitxer privat .env: $envPath"
}
if (-not (Test-Path $botSource)) {
    throw "No s'ha trobat el codi del bot actiu: $botSource"
}
if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    throw "No existeix la tasca programada '$taskName'."
}

$values = [ordered]@{
    "MT5_TERMINAL_PATH" = "C:\Program Files\MetaTrader 5 bot 2\terminal64.exe"
    "MT5_ACCOUNT" = "730432938"
    "MT5_SYMBOL" = "XAUUSD"
    "MT5_MAGIC_NUMBER" = "20260723122"
    "SYNC_INTERVAL_SECONDS" = "60"
    "RISK_PROBE_SECONDS" = "5"
    "BOT_ID" = "R2-A-BITGET-REAL"
    "BOT_VERSION" = "R2-A spread/ATR 0.12 grid 2.25 cap 0.07"
    "BOT_SOURCE_PATH" = $botSource
    "BOT_RUNTIME_DIR" = $runtimeDir
    "BOT_NEWS_FILE" = $newsFile
    "BOT_REFERENCE_EQUITY" = "2500"
    "BOT_RESERVE_PCT" = "20"
    "BOT_MAX_AUTO_SCALE" = "400"
    "BOT_BASE_LOT" = "0.01"
    "BOT_BASE_MAX_TOTAL_LOT" = "0.07"
    "BOT_BASE_MAX_FLOATING_LOSS" = "350"
    "BOT_MAX_ORDERS" = "8"
    "BOT_GRID_STEP_USD" = "2.25"
    "BOT_SPREAD_ATR_LIMIT" = "0.12"
    "BOT_NEWS_BLOCK_BEFORE_MINUTES" = "30"
    "BOT_NEWS_BLOCK_AFTER_MINUTES" = "60"
    "BOT_ROLLOVER_BLOCK_MINUTES" = "5"
}

$existing = Get-Content $envPath -Encoding UTF8
$secretNames = @("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
foreach ($secretName in $secretNames) {
    $match = $existing | Where-Object { $_ -match "^$secretName=.+$" }
    if (-not $match) {
        throw "Falta $secretName al .env. No es modifica res."
    }
}

$output = [System.Collections.Generic.List[string]]::new()
$written = [System.Collections.Generic.HashSet[string]]::new()
foreach ($line in $existing) {
    if ($line -match "^([^#=\s]+)=") {
        $name = $Matches[1]
        if ($values.Contains($name)) {
            $output.Add("$name=$($values[$name])")
            [void]$written.Add($name)
            continue
        }
    }
    $output.Add($line)
}
foreach ($entry in $values.GetEnumerator()) {
    if (-not $written.Contains($entry.Key)) {
        $output.Add("$($entry.Key)=$($entry.Value)")
    }
}

$backup = "$envPath.backup_$(Get-Date -Format yyyyMMdd_HHmmss)"
Copy-Item $envPath $backup -Force
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envPath, $output, $utf8NoBom)

py -3 -m py_compile (Join-Path $syncDir "sync_mt5_to_supabase.py")
if ($LASTEXITCODE -ne 0) {
    Copy-Item $backup $envPath -Force
    throw "El sincronitzador no compila. S'ha restaurat el .env."
}

Stop-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 12

$task = Get-ScheduledTask -TaskName $taskName
if ($task.State -ne "Running") {
    throw "La tasca no ha quedat Running. Revisa sync.log."
}

Write-Host "Telemetria completa configurada."
Write-Host "Tasca: $($task.State)"
Write-Host "Backup privat del .env: $backup"
Write-Host "No s'ha enviat cap ordre a MT5."
