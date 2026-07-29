# Dashboard XAUUSD R2-A

Dashboard públic de només lectura per seguir el bot R2-A.

## Anàlisi diària

- `GET /api/analysis-context` exposa només mètriques agregades i no inclou el login del compte.
- `/analisis` mostra els informes del repositori separat `Gartecz/R2A-Analisis-Diaris`.
- El navegador només descarrega els informes del mes seleccionat.
- L’agent analista no pot operar MT5 ni modificar aquest repositori.

## Desenvolupament

```bash
npm ci
npm run build
npm run lint
```

Les variables de Vercel continuen sent `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` i `VITE_MT5_ACCOUNT`.
