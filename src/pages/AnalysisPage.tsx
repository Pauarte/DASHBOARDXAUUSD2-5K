import { useEffect, useMemo, useState } from 'react'
import {
  fetchAnalysisDates,
  fetchDailyAnalysesForMonth,
  type DailyAnalysis,
  type AnalysisStatus,
} from '../lib/analysisReports'

const WEEKDAYS = ['Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds', 'Dg']

const STATUS_LABEL: Record<AnalysisStatus, string> = {
  normal: 'Normal',
  watch: 'Vigilància',
  alert: 'Alerta',
  insufficient_data: 'Dades insuficients',
}

const STATUS_CLASS: Record<AnalysisStatus, string> = {
  normal: 'border-emerald-600/40 bg-emerald-950/20 text-emerald-300',
  watch: 'border-amber-600/40 bg-amber-950/20 text-amber-200',
  alert: 'border-red-600/40 bg-red-950/20 text-red-200',
  insufficient_data: 'border-slate-500/40 bg-slate-800/30 text-slate-300',
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function daysForMonth(key: string) {
  const [year, month] = key.split('-').map(Number)
  const first = new Date(year, month - 1, 1)
  const total = new Date(year, month, 0).getDate()
  const mondayOffset = (first.getDay() + 6) % 7
  return [
    ...Array.from({ length: mondayOffset }, () => null),
    ...Array.from({ length: total }, (_, index) => index + 1),
  ]
}

function metric(value: number | null, suffix = '') {
  return value === null ? '—' : `${value.toFixed(2)}${suffix}`
}

export function AnalysisPage() {
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [datesLoaded, setDatesLoaded] = useState(false)
  const [reports, setReports] = useState<DailyAnalysis[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [selectedMonth, setSelectedMonth] = useState(monthKey(new Date()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchAnalysisDates()
      .then((dates) => {
        setAvailableDates(dates)
        if (dates[0]) {
          setSelectedDate(dates[0])
          setSelectedMonth(dates[0].slice(0, 7))
        }
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'No s’han pogut carregar els informes')
      })
      .finally(() => setDatesLoaded(true))
  }, [])

  useEffect(() => {
    if (!datesLoaded) return

    if (availableDates.length === 0) {
      setReports([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    fetchDailyAnalysesForMonth(selectedMonth, availableDates)
      .then((loaded) => {
        setReports(loaded)
        if (!selectedDate?.startsWith(`${selectedMonth}-`)) {
          setSelectedDate(loaded[0]?.date ?? null)
        }
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'No s’han pogut carregar els informes')
      })
      .finally(() => setLoading(false))
  }, [availableDates, datesLoaded, selectedDate, selectedMonth])

  const reportsByDate = useMemo(
    () => new Map(reports.map((report) => [report.date, report])),
    [reports],
  )
  const selected = selectedDate ? reportsByDate.get(selectedDate) ?? null : null
  const [year, month] = selectedMonth.split('-').map(Number)
  const calendarDays = daysForMonth(selectedMonth)

  return (
    <div className="min-h-screen bg-[var(--surface-2)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface-card)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-5">
          <div>
            <h1 className="text-lg font-semibold">Anàlisi diària R2-A</h1>
            <p className="text-xs text-[var(--text-muted)]">Informes automàtics de només lectura</p>
          </div>
          <a
            href="/"
            className="rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
          >
            Tornar al monitor
          </a>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Calendari d’informes</h2>
              <p className="text-sm text-[var(--text-muted)]">
                Només es poden obrir els dies que tenen anàlisi publicada.
              </p>
            </div>
            <input
              type="month"
              value={selectedMonth}
              onChange={(event) => {
                if (event.target.value) setSelectedMonth(event.target.value)
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
            />
          </div>

          {loading && <p className="text-sm text-[var(--text-muted)]">Carregant informes…</p>}
          {error && <p className="text-sm text-[var(--critical)]">{error}</p>}
          {datesLoaded && !loading && !error && availableDates.length === 0 && (
            <p className="text-sm text-[var(--text-muted)]">
              Encara no hi ha cap informe diari publicat.
            </p>
          )}

          {!loading && !error && (
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAYS.map((day) => (
                <div key={day} className="py-1 text-center text-xs font-medium text-[var(--text-muted)]">
                  {day}
                </div>
              ))}
              {calendarDays.map((day, index) => {
                if (day === null) return <div key={`empty-${index}`} />
                const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                const report = reportsByDate.get(date)
                return (
                  <button
                    key={date}
                    type="button"
                    disabled={!report}
                    onClick={() => setSelectedDate(date)}
                    className={`min-h-14 rounded-lg border p-2 text-sm transition ${
                      report
                        ? `${STATUS_CLASS[report.status]} hover:brightness-110`
                        : 'cursor-not-allowed border-transparent bg-[var(--surface-2)] text-[var(--text-muted)] opacity-45'
                    } ${selectedDate === date ? 'ring-2 ring-blue-500' : ''}`}
                    title={report ? report.summary : 'Sense informe'}
                  >
                    {day}
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {selected && (
          <article className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-6">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[var(--text-muted)]">{selected.date}</p>
                <h2 className="text-xl font-semibold">{selected.summary}</h2>
              </div>
              <span className={`rounded-full border px-3 py-1 text-xs font-medium ${STATUS_CLASS[selected.status]}`}>
                {STATUS_LABEL[selected.status]}
              </span>
            </div>

            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <ReportMetric label="Balance" value={metric(selected.metrics.balance, ' $')} />
              <ReportMetric label="P&L diari" value={metric(selected.metrics.daily_pnl, ' $')} />
              <ReportMetric label="Retorn diari" value={metric(selected.metrics.daily_return_pct, '%')} />
              <ReportMetric label="Operacions" value={selected.metrics.closed_operations?.toString() ?? '—'} />
              <ReportMetric label="Win rate" value={metric(selected.metrics.win_rate_pct, '%')} />
              <ReportMetric label="Floating actual" value={metric(selected.metrics.floating_pnl, ' $')} />
              <ReportMetric label="Pitjor floating" value={metric(selected.metrics.worst_floating_day, ' $')} />
              <ReportMetric label="Posicions obertes" value={selected.metrics.open_positions?.toString() ?? '—'} />
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <ReportSection title="Rendiment" text={selected.assessment.performance} />
              <ReportSection title="Risc" text={selected.assessment.risk} />
              <ReportSection title="Execució" text={selected.assessment.execution} />
              <ReportSection title="Conclusió" text={selected.assessment.conclusion} />
            </div>

            {selected.alerts.length > 0 && (
              <div className="mt-6 rounded-lg border border-amber-600/30 bg-amber-950/20 p-4">
                <h3 className="mb-2 font-medium text-amber-200">Alertes</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-100">
                  {selected.alerts.map((alert) => <li key={alert}>{alert}</li>)}
                </ul>
              </div>
            )}
          </article>
        )}
      </main>
    </div>
  )
}

function ReportMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 font-semibold tabular">{value}</div>
    </div>
  )
}

function ReportSection({ title, text }: { title: string; text: string }) {
  return (
    <section>
      <h3 className="mb-1 font-medium">{title}</h3>
      <p className="whitespace-pre-line text-sm leading-6 text-[var(--text-secondary)]">{text}</p>
    </section>
  )
}
