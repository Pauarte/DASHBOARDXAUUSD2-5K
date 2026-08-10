# Dashboard XAUUSD R2-A

Dashboard públic de només lectura per seguir el bot R2-A.

## Anàlisi diària

- `GET /api/analysis-context` exposa només mètriques agregades i no inclou el login del compte.
- `/analisis` mostra els informes del repositori separat `Gartecz/R2A-Analisis-Diaris`.
- El navegador només descarrega els informes del mes seleccionat.
- L’agent analista no pot operar MT5 ni modificar aquest repositori.

## Accés tècnic de només lectura (`analysis_reader`)

- `GET /api/analysis/v1/report-data?date=YYYY-MM-DD&timezone=Europe/Madrid` — API versionada,
  només lectura, protegida per un token propi (no l’anon key de Supabase). Mètode ≠ GET/HEAD/OPTIONS → 405.
  Token invàlid/revocat/caducat → 401/403. Massa peticions → 429.
- `/analisi-tecnica` — perfil visual "Solo lectura" al dashboard, separat del login de socis.
- El rol de base de dades `analysis_reader` només té `SELECT` sobre vistes `analysis_v1_*`
  (mai sobre `trades`/`open_positions`/`capital_contributions` directament) — vegeu
  `supabase/analysis_reader.sql`. No pot obrir, tancar ni modificar operacions, ni tocar
  configuració del bot.
- `POST /api/analysis/v1/internal/generate-daily-snapshot` — job intern (Vercel Cron, secret
  propi), escriu el resum diari amb un rol `analysis_snapshot_writer` diferent, que només pot
  escriure a `analysis_daily_snapshots`/`analysis_incidents`.

## Desenvolupament

```bash
npm ci
npm run build
npm run lint
```

Les variables de Vercel continuen sent `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` i `VITE_MT5_ACCOUNT`.
