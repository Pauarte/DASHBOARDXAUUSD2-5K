import { useEffect, useState } from 'react'
import { clearAnalysisToken, loadStoredAnalysisToken, storeAnalysisToken } from '../lib/analysisReaderAuth'
import { StatTile } from '../components/StatTile'
import { formatDateTime } from '../lib/format'

// This page is intentionally read-only end to end:
//  - no form posts anything anywhere; the only network call is a GET to
//    /api/analysis/v1/report-data.
//  - no link to /socis (capital admin) or the main dashboard.
//  - the API itself rejects non-GET methods and unknown/revoked tokens
//    server-side (see api/analysis/v1/report-data.js) - this page hiding
//    buttons is a UX nicety, not the actual security boundary.

type ReportData = Record<string, unknown> & {
  ok: boolean
  meta?: Record<string, unknown>
  bot?: Record<string, unknown>
  account?: Record<string, unknown>
  performance?: Record<string, unknown>
  risk?: Record<string, unknown>
  open_positions?: Array<Record<string, unknown>>
  closed_trades?: { total_count: number; items: Array<Record<string, unknown>> }
  baskets?: { total_count: number; items: Array<Record<string, unknown>> }
  incidents?: { items: Array<Record<string, unknown>> }
  error?: string
}

export function AnalysisReaderPage() {
  const [token, setToken] = useState<string | null>(() => loadStoredAnalysisToken())
  const [tokenInput, setTokenInput] = useState('')
  const [date, setDate] = useState('')
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const url = new URL('/api/analysis/v1/report-data', window.location.origin)
    if (date) url.searchParams.set('date', date)
    url.searchParams.set('timezone', 'Europe/Madrid')

    fetch(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (cancelled) return
        const body = (await response.json()) as ReportData
        if (response.status === 401 || response.status === 403) {
          clearAnalysisToken()
          setToken(null)
          setError('Token invàlid, revocat o caducat. Torna a introduir-lo.')
          return
        }
        if (!response.ok) {
          setError(body.error ?? `Error ${response.status}`)
          return
        }
        setData(body)
      })
      .catch(() => {
        if (!cancelled) setError('No s’ha pogut contactar amb l’API d’anàlisi.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [token, date])

  if (!token) {
    return (
      <div className="min-h-screen bg-[var(--surface-2)] flex items-center justify-center px-6">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!tokenInput.trim()) return
            storeAnalysisToken(tokenInput.trim())
            setToken(tokenInput.trim())
            setTokenInput('')
          }}
          className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-6 flex flex-col gap-3"
        >
          <h1 className="text-base font-semibold text-[var(--text-primary)]">Accés tècnic · Solo lectura</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Introdueix el token d’anàlisi (analysis_reader). No dona accés d’escriptura ni operativa sobre el bot.
          </p>
          <input
            type="password"
            autoFocus
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Token"
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm font-mono"
          />
          <button type="submit" className="rounded-lg bg-[var(--series-blue)] px-4 py-2 text-sm font-semibold text-white">
            Entrar
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--surface-2)]">
      <div className="bg-amber-900/60 border-b border-amber-700/50 px-6 py-2 text-center text-xs font-semibold tracking-wide text-amber-100 uppercase">
        Solo lectura · Accés d’anàlisi tècnica · Cap operació possible des d’aquí
      </div>
      <header className="border-b border-[var(--border)] bg-[var(--surface-card)]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <h1 className="text-base font-semibold">Anàlisi tècnica R2-A</h1>
            <p className="text-xs text-[var(--text-muted)]">
              {typeof data?.bot?.account_masked === 'string' ? data.bot.account_masked : '—'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs"
            />
            <button
              type="button"
              onClick={() => setDate('')}
              className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              Avui
            </button>
            <button
              type="button"
              onClick={() => {
                clearAnalysisToken()
                setToken(null)
                setData(null)
              }}
              className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              Sortir
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
        {loading && <p className="text-sm text-[var(--text-muted)]">Carregant…</p>}
        {error && <p className="text-sm text-[var(--critical)]">{error}</p>}

        {data?.ok && (
          <>
            <FreshnessBar meta={data.meta} />

            <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile label="Balance" value={money(data.account?.balance)} />
              <StatTile label="Equity" value={money(data.account?.equity)} />
              <StatTile label="Floating" value={money(data.account?.floating_pnl)} />
              <StatTile
                label="P&L del dia"
                value={money((data.performance?.day as Record<string, unknown> | undefined)?.net_profit)}
              />
            </section>

            <Section title="Rendiment">
              <Pre value={data.performance} />
            </Section>

            <Section title="Risc">
              <Pre value={data.risk} />
            </Section>

            <Section title={`Posicions obertes (${data.open_positions?.length ?? 0})`}>
              <Pre value={data.open_positions} />
            </Section>

            <Section title={`Operacions tancades (${data.closed_trades?.total_count ?? 0} total)`}>
              <Pre value={data.closed_trades} />
            </Section>

            <Section title={`Cistelles (${data.baskets?.total_count ?? 0})`}>
              <Pre value={data.baskets} />
            </Section>

            <Section title="Incidències">
              <Pre value={data.incidents} />
            </Section>

            <Section title="Meta / qualitat de dades">
              <Pre value={data.meta} />
            </Section>
          </>
        )}
      </main>
    </div>
  )
}

function FreshnessBar({ meta }: { meta?: Record<string, unknown> }) {
  if (!meta) return null
  const dataAsOf = typeof meta.data_as_of === 'string' ? meta.data_as_of : null
  const ageSeconds = typeof meta.data_age_seconds === 'number' ? meta.data_age_seconds : null
  const status = typeof meta.sync_status === 'string' ? meta.sync_status : 'unknown'
  const tone = status === 'ok' ? 'text-[var(--good-text)]' : 'text-[var(--critical)]'
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-card)] px-4 py-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className={`font-semibold ${tone}`}>Sync: {status}</span>
      <span className="text-[var(--text-muted)]">
        Dades de {dataAsOf ? formatDateTime(dataAsOf) : '—'} ({ageSeconds ?? '—'}s d’antiguitat)
      </span>
      <span className="text-[var(--text-muted)]">Data resolta: {String(meta.resolved_date ?? '—')}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <h2 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
      {children}
    </section>
  )
}

// Raw-but-readable JSON view - this page is a technical/analysis surface,
// not a polished consumer UI, so a formatted JSON block (rather than
// bespoke widgets for 80+ fields) is the honest, low-maintenance choice.
function Pre({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs text-[var(--text-secondary)]">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function money(value: unknown): string {
  return typeof value === 'number' ? `${value.toFixed(2)} $` : '—'
}
