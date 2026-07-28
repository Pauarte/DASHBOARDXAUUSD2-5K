# Registra una Tasca Programada de Windows que vigila l'script de
# sincronitzacio: si es tanca (es penja, l'ordinador es reinicia, algu
# tanca la finestra sense voler...) el torna a engegar sol en menys d'1 min.
#
# NOMES CAL EXECUTAR AIXO UN COP (com a Administrador). A partir d'aqui,
# ja no cal fer doble clic a res mai mes -- ni per mantenir-lo viu ni per
# rebre actualitzacions (l'script mateix es comprova i s'actualitza sol,
# vegeu SELF_UPDATE_URL dins sync_mt5_to_supabase.py).

$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$taskName = "MT5SupabaseSync"

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dir\actualitza_i_engega.ps1`""

$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$watchdogTrigger = New-ScheduledTaskTrigger `
    -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# IgnoreNew: si ja esta corrent, la comprovacio de cada minut no fa res.
# Nomes el torna a engegar quan detecta que NO esta corrent.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger @($startupTrigger, $watchdogTrigger) `
    -Settings $settings `
    -RunLevel Highest `
    -Force | Out-Null

Write-Host "Tasca '$taskName' registrada. A partir d'ara es vigila sola i"
Write-Host "es torna a engegar automaticament si mai es para."
Write-Host ""
Write-Host "Si vols aturar-la manualment algun dia:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
