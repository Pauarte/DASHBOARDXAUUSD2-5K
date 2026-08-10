import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { CurrencyProvider } from './lib/currency.tsx'

// Lazy-loaded so each route ships its own chunk (Recharts, the GitHub
// report-fetching logic, the capital-pool math, ...) instead of all four
// pages landing in one bundle that every visitor downloads regardless of
// which route they're on. React.lazy only fetches a chunk the moment that
// component actually renders, and pathname-based routing here means
// exactly one of these four ever does per page load.
const App = lazy(() => import('./App.tsx'))
const PartnersPage = lazy(() => import('./pages/PartnersPage.tsx').then((m) => ({ default: m.PartnersPage })))
const AnalysisPage = lazy(() => import('./pages/AnalysisPage.tsx').then((m) => ({ default: m.AnalysisPage })))
const AnalysisReaderPage = lazy(() =>
  import('./pages/AnalysisReaderPage.tsx').then((m) => ({ default: m.AnalysisReaderPage })),
)

// No router library — plain pathname checks keep each secondary route out
// of the others' nav/bundle story. /analisi-tecnica is the read-only
// "analysis_reader" profile (api/analysis/v1/report-data.js) - distinct
// from /analisis, which shows the separate narrative daily-report pipeline.
const Root =
  window.location.pathname === '/socis'
    ? PartnersPage
    : window.location.pathname === '/analisis'
      ? AnalysisPage
      : window.location.pathname === '/analisi-tecnica'
        ? AnalysisReaderPage
        : App

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--surface-2)]">
      <div className="h-8 w-8 rounded-full border-2 border-[var(--border)] border-t-transparent animate-spin" />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CurrencyProvider>
      <Suspense fallback={<RouteFallback />}>
        <Root />
      </Suspense>
    </CurrencyProvider>
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js'))
}
