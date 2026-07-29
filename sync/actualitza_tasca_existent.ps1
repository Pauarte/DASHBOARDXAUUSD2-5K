# Actualitza NOMES el fitxer de l'script del sincronitzador MT5 -> Supabase.
#
# Fa servir la tasca de Windows JA EXISTENT "MT5-Supabase-Sync" -- no en
# crea cap altra, no en modifica l'accio ni la configuracio (reinici
# automatic, usuari, etc. es queden tal com el vostre cosi els va deixar).
# Nomes: atura aquesta tasca concreta, substitueix el fitxer .py, i la
# torna a engegar.
#
# Seguretat:
#   - Si NO existeix cap tasca amb aquest nom exacte, l'script s'atura
#     immediatament SENSE tocar ni crear res.
#   - Nomes fa servir Stop-ScheduledTask / Start-ScheduledTask, que nomes
#     afecten el proces d'AQUESTA tasca -- mai es mata cap altre proces
#     Python a ma.
#   - El .env NO es toca en cap moment.
#   - No queda cap finestra de PowerShell oberta en acabar: l'script
#     nomes actualitza el fitxer i reengega la tasca, que corre en segon
#     pla segons la seva propia configuracio.
#   - Aquest script no obre, tanca ni modifica cap operacio a MT5 -- nomes
#     substitueix el fitxer de codi del sincronitzador (que tampoc ho fa).

$ErrorActionPreference = "Stop"

$taskName = "MT5-Supabase-Sync"
$dir = $PSScriptRoot
$repoRaw = "https://raw.githubusercontent.com/Pauarte/DASHBOARDXAUUSD2-5K/main/sync"
$scriptPath = Join-Path $dir "sync_mt5_to_supabase.py"
$runnerPath = Join-Path $dir "run_supabase_sync.ps1"
$configurePath = Join-Path $dir "configura_tasca_resilient.ps1"
$tmpPath = "$scriptPath.new"
$tmpRunnerPath = "$runnerPath.new"
$tmpConfigurePath = "$configurePath.new"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "ATURAT: no existeix cap tasca anomenada '$taskName' en aquest ordinador."
    Write-Host "No es crea ni es modifica RES. Confirma el nom exacte de la tasca abans de tornar a provar."
    exit 1
}

Write-Host "Tasca '$taskName' trobada (estat actual: $($task.State))."

Write-Host "Descarregant la darrera versio de l'script a un fitxer temporal..."
Invoke-WebRequest -Uri "$repoRaw/sync_mt5_to_supabase.py" -OutFile $tmpPath
Invoke-WebRequest -Uri "$repoRaw/run_supabase_sync.ps1" -OutFile $tmpRunnerPath
Invoke-WebRequest -Uri "$repoRaw/configura_tasca_resilient.ps1" -OutFile $tmpConfigurePath

$content = Get-Content $tmpPath -Raw
if ([string]::IsNullOrWhiteSpace($content) -or $content -notmatch "def main\(") {
    Remove-Item $tmpPath -ErrorAction SilentlyContinue
    Remove-Item $tmpRunnerPath -ErrorAction SilentlyContinue
    Remove-Item $tmpConfigurePath -ErrorAction SilentlyContinue
    throw "La descarrega no sembla un script valid -- no es toca res. Torna-ho a provar mes tard."
}

# Comprovacio real de sintaxi Python (py_compile). Aixo detecta qualsevol
# corrupcio del fitxer (per exemple, si s'ha enganxat codi a traves d'un
# xat que ha convertit "__file__" en "**file**" en negreta) ABANS de
# substituir l'script que ja funciona -- si falla, no es toca res.
py -3 -m py_compile $tmpPath
if ($LASTEXITCODE -ne 0) {
    Remove-Item $tmpPath -ErrorAction SilentlyContinue
    Remove-Item $tmpRunnerPath -ErrorAction SilentlyContinue
    Remove-Item $tmpConfigurePath -ErrorAction SilentlyContinue
    Remove-Item "$tmpPath.pyc" -ErrorAction SilentlyContinue
    throw "El fitxer descarregat NO compila (sintaxi invalida) -- no es toca res. Avisa abans de reintentar."
}
Remove-Item (Join-Path (Split-Path $tmpPath) "__pycache__") -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Descarregant requirements.txt..."
Invoke-WebRequest -Uri "$repoRaw/requirements.txt" -OutFile (Join-Path $dir "requirements.txt")

Write-Host "Aturant NOMES la tasca '$taskName' (no es toca cap altre proces)..."
Stop-ScheduledTask -TaskName $taskName

Write-Host "Substituint l'script pel nou..."
Copy-Item $scriptPath "$scriptPath.backup" -Force -ErrorAction SilentlyContinue
Move-Item -Force $tmpPath $scriptPath
Move-Item -Force $tmpRunnerPath $runnerPath
Move-Item -Force $tmpConfigurePath $configurePath

Write-Host "Instal-lant/actualitzant dependencies..."
py -3 -m pip install -r (Join-Path $dir "requirements.txt") | Out-Null

Write-Host "Configurant la tasca resilient i tornant-la a engegar..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $configurePath
if ($LASTEXITCODE -ne 0) {
    throw "No s'ha pogut configurar la tasca resilient."
}

Write-Host ""
Write-Host "Fet. La tasca '$taskName' ja corre l'script nou."
Write-Host "El .env no s'ha tocat, l'script ja no s'automodifica i"
Write-Host "Windows el reiniciara automaticament si algun dia cau."
Write-Host "No queda cap finestra oberta."
