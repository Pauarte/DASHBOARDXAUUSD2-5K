# Actualitza l'script de sincronitzacio MT5 -> Supabase a la darrera versio
# del repositori i el torna a engegar. Fes-lo servir cada vegada que et
# diguem que hi ha una actualitzacio -- nomes cal executar aquest fitxer.
#
# No toca el teu .env (les claus es queden tal com estan).

$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$repoRaw = "https://raw.githubusercontent.com/Pauarte/DASHBOARDXAUUSD2-5K/main/sync"

Write-Host "Aturant instancies anteriors de l'script (si n'hi ha)..."
Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
    Where-Object { $_.CommandLine -like "*sync_mt5_to_supabase.py*" } |
    ForEach-Object {
        Write-Host "  Aturant PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force
    }

Write-Host "Descarregant la darrera versio..."
Invoke-WebRequest -Uri "$repoRaw/sync_mt5_to_supabase.py" -OutFile "$dir\sync_mt5_to_supabase.py"
Invoke-WebRequest -Uri "$repoRaw/requirements.txt" -OutFile "$dir\requirements.txt"

Write-Host "Instal-lant dependencies..."
pip install -r "$dir\requirements.txt"

Write-Host "Engegant l'script (deixa aquesta finestra oberta)..."
python "$dir\sync_mt5_to_supabase.py"
