$ErrorActionPreference = "Stop"

$syncDir = $PSScriptRoot
$scriptPath = Join-Path $syncDir "sync_mt5_to_supabase.py"
$logPath = Join-Path $syncDir "sync.log"

Set-Location $syncDir

$pythonPath = (& py -3 -c "import sys; print(sys.executable)").Trim()
if (-not $pythonPath -or -not (Test-Path $pythonPath)) {
    throw "No s'ha trobat l'executable de Python 3."
}

& $pythonPath -u $scriptPath *>> $logPath
exit $LASTEXITCODE
