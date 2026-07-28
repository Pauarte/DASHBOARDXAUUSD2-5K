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
$tmpPath = "$scriptPath.new"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "ATURAT: no existeix cap tasca anomenada '$taskName' en aquest ordinador."
    Write-Host "No es crea ni es modifica RES. Confirma el nom exacte de la tasca abans de tornar a provar."
    exit 1
}

Write-Host "Tasca '$taskName' trobada (estat actual: $($task.State))."

Write-Host "Descarregant la darrera versio de l'script a un fitxer temporal..."
Invoke-WebRequest -Uri "$repoRaw/sync_mt5_to_supabase.py" -OutFile $tmpPath

$content = Get-Content $tmpPath -Raw
if ([string]::IsNullOrWhiteSpace($content) -or $content -notmatch "def main\(") {
    Remove-Item $tmpPath -ErrorAction SilentlyContinue
    throw "La descarrega no sembla un script valid -- no es toca res. Torna-ho a provar mes tard."
}

Write-Host "Descarregant requirements.txt..."
Invoke-WebRequest -Uri "$repoRaw/requirements.txt" -OutFile (Join-Path $dir "requirements.txt")

Write-Host "Aturant NOMES la tasca '$taskName' (no es toca cap altre proces)..."
Stop-ScheduledTask -TaskName $taskName

Write-Host "Substituint l'script pel nou..."
Move-Item -Force $tmpPath $scriptPath

Write-Host "Instal-lant/actualitzant dependencies..."
pip install -r (Join-Path $dir "requirements.txt") | Out-Null

Write-Host "Tornant a engegar la tasca '$taskName'..."
Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "Fet. La tasca '$taskName' ja corre l'script nou, amb la seva"
Write-Host "propia configuracio de reinici automatic. El .env no s'ha tocat."
Write-Host "No queda cap finestra oberta."
