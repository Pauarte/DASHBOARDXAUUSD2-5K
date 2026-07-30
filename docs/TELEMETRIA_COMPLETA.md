# Telemetria completa del bot R2-A

## Objectiu

Conservar prou informació per reconstruir què va passar abans, durant i
després de cada cistella, comparar l'execució real amb el simulador i detectar
canvis de broker, mercat, costos o configuració.

El sincronitzador és de només lectura. No importa el bot, no modifica fitxers
del bot i no envia ordres a MT5.

## Dues capes

### Resum visible

`telemetry_summary` conté un únic registre actual. El dashboard pot llegir-lo
amb la clau anon i mostra:

- drawdown global i intradia;
- floating i percentatge del límit utilitzat;
- lots i percentatge del cap utilitzat;
- spread, spread/ATR, ATR, RSI i ADX;
- moviments recents de 5, 15 i 60 minuts;
- límits efectius segons el balance;
- bloqueig de notícies i rollover;
- estat i durada de la sincronització.

### Auditoria privada

Les taules següents tenen RLS activat i cap policy anon:

- `account_telemetry`: compte i mercat cada minut;
- `position_telemetry`: cada posició oberta cada minut;
- `risk_probes`: equity, floating i spread cada 5 segons mentre hi ha risc;
- `market_telemetry`: OHLC i indicadors M1/M5;
- `raw_deals`: deals MT5 sense reagrupar;
- `raw_orders`: ordres MT5 i preu sol·licitat disponible;
- `bot_versions`: hash de codi i configuració;
- `bot_runtime_events`: files noves dels CSV/JSON natius del bot;
- `economic_events`: calendari que realment utilitza el bot;
- `sync_health`: una auditoria de cada passada.

`basket_telemetry` agrupa totes les potes d'una cistella i calcula costos,
durada, MAE, MFE, spread, slippage i balance d'inici/final.

## Precisió i límits

- MAE/MFE té resolució d'un minut i de 5 segons mentre hi ha posicions.
- La comissió, swap, fee i profit provenen dels deals MT5.
- El slippage es calcula amb el preu sol·licitat de l'ordre i el preu real del
  deal. Si el broker no conserva el preu sol·licitat, queda `null`; no
  s'inventa cap valor.
- El motiu MT5 es desa com a codi cru. Quan el bot tanca mitjançant una ordre
  d'expert, MT5 no sempre diferencia trailing, rescue o sortida temporal.
  `BOT_RUNTIME_DIR` permet conservar els CSV/JSON natius que sí poden explicar-ho.
- El calendari històric només conté els esdeveniments que el fitxer de notícies
  del bot hagi arribat a registrar. No es creen notícies retroactives.

## API per al xat

`/api/analysis-context` continua sent el resum segur per a l'anàlisi diària.

`/api/private-telemetry` permet una auditoria profunda i exigeix:

- `SUPABASE_SERVICE_ROLE_KEY` al servidor Vercel;
- `ANALYSIS_API_TOKEN` de 32 caràcters o més;
- `Authorization: Bearer TOKEN`.

Paràmetres:

- `hours=24` fins a un màxim de 744;
- `detail=raw` per incloure deals, ordres i runtime.

No s'ha de publicar la URL amb token, ni posar aquestes claus al frontend.

## Instal·lació

1. Executar `supabase/migrations/20260730_full_private_telemetry.sql`.
2. Actualitzar `sync_mt5_to_supabase.py` amb l'actualitzador existent.
3. Executar una vegada `sync/configura_telemetria_completa.ps1` al VPS.
4. Configurar a Vercel `SUPABASE_SERVICE_ROLE_KEY` i `ANALYSIS_API_TOKEN`.
5. Verificar que el log mostra `Sync pass OK` i que `telemetry_summary` canvia.

La migració és additiva: no elimina cap taula ni historial existent.
