$ErrorActionPreference = "Stop"

$desktop = [Environment]::GetFolderPath("Desktop")
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$packageName = "PAQUET_ANALISI_R2A_$stamp"
$stage = Join-Path $desktop $packageName
$zip = "$stage.zip"
$syncDir = $PSScriptRoot
$envFile = Join-Path $syncDir ".env"
$botDir = "C:\Users\Administrator\Desktop\BITGET_R2A_REAL_2500USD_730432938"
$webRoot = Split-Path $syncDir -Parent

if (-not (Test-Path $envFile)) {
    throw "No existeix el fitxer privat .env a $envFile"
}
if (-not (Test-Path $botDir)) {
    throw "No existeix la carpeta del bot actiu: $botDir"
}
if (Test-Path $stage) {
    throw "La carpeta de sortida ja existeix: $stage"
}

New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "bot_actiu") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "sync") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "sistema") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "backtests_candidats") | Out-Null

$secretPatterns = @(
    ".env", ".env.*", "*.env", "*token*", "*secret*", "*password*",
    "*credential*", "*.key", "*.pem", "*.pfx", "*.backup*"
)

function Test-SafeFile {
    param([System.IO.FileInfo]$File)
    foreach ($pattern in $secretPatterns) {
        if ($File.Name -like $pattern) { return $false }
    }
    return $File.Length -le 104857600
}

function Copy-SafeTree {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path $Source)) { return }
    $sourcePath = (Resolve-Path $Source).Path
    Get-ChildItem $sourcePath -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
            (Test-SafeFile $_) -and
            $_.FullName -notmatch "\\(__pycache__|\.git|node_modules)\\"
        } |
        ForEach-Object {
            $relative = $_.FullName.Substring($sourcePath.Length).TrimStart("\")
            $target = Join-Path $Destination $relative
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            Copy-Item $_.FullName $target -Force
        }
}

Write-Host "Copiant codi, configuracio publica i runtime del bot..."
Copy-SafeTree $botDir (Join-Path $stage "bot_actiu")

Write-Host "Copiant scripts i logs del sincronitzador sense secrets..."
Get-ChildItem $syncDir -File -ErrorAction SilentlyContinue |
    Where-Object { Test-SafeFile $_ } |
    ForEach-Object {
        $syncTarget = Join-Path (Join-Path $stage "sync") $_.Name
        Copy-Item $_.FullName $syncTarget -Force
    }

Write-Host "Exportant dades MT5 i Supabase en mode nomes lectura..."
py -3 -m pip install -r (Join-Path $syncDir "requirements.txt") --disable-pip-version-check | Out-Null
py -3 (Join-Path $syncDir "export_analysis_data.py") `
    --env-file $envFile `
    --output (Join-Path $stage "dades") `
    --log-days 90
if ($LASTEXITCODE -ne 0) {
    throw "L'exportador de dades ha informat d'un error. Revisa export_status.json."
}

Write-Host "Recollint estat del sistema i de la tasca..."
Get-ComputerInfo |
    Select-Object WindowsProductName, WindowsVersion, OsArchitecture, CsTotalPhysicalMemory |
    ConvertTo-Json |
    Set-Content (Join-Path $stage "sistema\computer_info.json") -Encoding UTF8

Get-Process terminal64, python, pythonw -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, Path, StartTime |
    ConvertTo-Json |
    Set-Content (Join-Path $stage "sistema\processos.json") -Encoding UTF8

$task = Get-ScheduledTask -TaskName "MT5-Supabase-Sync" -ErrorAction SilentlyContinue
if ($task) {
    Export-ScheduledTask -TaskName "MT5-Supabase-Sync" |
        Set-Content (Join-Path $stage "sistema\MT5-Supabase-Sync.xml") -Encoding UTF8
    Get-ScheduledTaskInfo -TaskName "MT5-Supabase-Sync" |
        ConvertTo-Json |
        Set-Content (Join-Path $stage "sistema\MT5-Supabase-Sync-info.json") -Encoding UTF8
}

Write-Host "Buscant resultats de backtest disponibles a l'escriptori..."
$extensions = @(".csv", ".json", ".html", ".htm", ".xlsx", ".txt", ".log")
$candidateDirs = Get-ChildItem $desktop -Directory -ErrorAction SilentlyContinue |
    Where-Object {
        $_.FullName -ne $botDir -and
        $_.FullName -ne $webRoot -and
        $_.Name -ne $packageName -and
        $_.Name -match "(?i)(backtest|rr0109|r2a|wide.taper)"
    }

foreach ($directory in $candidateDirs) {
    $destination = Join-Path $stage "backtests_candidats\$($directory.Name)"
    Get-ChildItem $directory.FullName -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
            $extensions -contains $_.Extension.ToLowerInvariant() -and
            (Test-SafeFile $_)
        } |
        ForEach-Object {
            $relative = $_.FullName.Substring($directory.FullName.Length).TrimStart("\")
            $target = Join-Path $destination $relative
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            Copy-Item $_.FullName $target -Force
        }
}

Write-Host "Generant manifest de fitxers i hashes..."
$manifest = Get-ChildItem $stage -Recurse -File |
    ForEach-Object {
        [pscustomobject]@{
            path = $_.FullName.Substring($stage.Length).TrimStart("\")
            bytes = $_.Length
            sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
        }
    }
$manifest | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $stage "MANIFEST.json") -Encoding UTF8

@"
Paquet d'analisi R2-A generat el $(Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz").
Exportacio de nomes lectura. No s'ha enviat cap ordre a MT5 ni s'ha escrit a Supabase.
No s'han inclos fitxers .env, claus, tokens, contrasenyes ni backups secrets.
"@ | Set-Content (Join-Path $stage "LLEGEIX_ME.txt") -Encoding UTF8

Write-Host "Comprimint el paquet..."
Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$entryCount = $archive.Entries.Count
$archive.Dispose()

Write-Host ""
Write-Host "EXPORTACIO COMPLETADA"
Write-Host "ZIP: $zip"
Write-Host "Carpeta sense comprimir: $stage"
Write-Host "Fitxers al ZIP: $entryCount"
Write-Host "No s'ha copiat cap .env ni s'ha enviat cap ordre a MT5."
