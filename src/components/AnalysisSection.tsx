import { useMemo, useState } from 'react'
import { addDays, addMonths, endOfMonth, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from 'date-fns'
import type { AnalysisReport } from '../lib/types'

interface Props { reports: AnalysisReport[] }

export function AnalysisSection({ reports }: Props) {
  const [month, setMonth] = useState(startOfMonth(new Date()))
  const [selected, setSelected] = useState<AnalysisReport | null>(reports[0] ?? null)
  const byDate = useMemo(() => new Map(reports.map((report) => [report.reportDate.slice(0, 10), report])), [reports])
  const first = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
  const last = endOfMonth(month)
  const days: Date[] = []
  for (let day = first; day <= last || days.length % 7 !== 0; day = addDays(day, 1)) days.push(day)

  return <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-card)] p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">Anàlisi</h2><p className="text-sm text-[var(--text-muted)]">Resums diaris, setmanals i mensuals del bot.</p></div>
      <span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs text-[var(--text-muted)]">{reports.length} informes</span>
    </div>
    <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
      <div>
        <div className="mb-3 flex items-center justify-between"><button onClick={() => setMonth(subMonths(month, 1))} className="rounded px-2 py-1 hover:bg-[var(--surface-2)]">‹</button><strong>{format(month, 'MMMM yyyy')}</strong><button onClick={() => setMonth(addMonths(month, 1))} className="rounded px-2 py-1 hover:bg-[var(--surface-2)]">›</button></div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-[var(--text-muted)]">{['Dl','Dt','Dc','Dj','Dv','Ds','Dg'].map((day) => <div key={day} className="py-1">{day}</div>)}
          {days.map((day) => { const report = byDate.get(format(day, 'yyyy-MM-dd')); return <button key={day.toISOString()} disabled={!report || !isSameMonth(day, month)} onClick={() => report && setSelected(report)} className={`min-h-10 rounded-lg p-1 text-xs ${!isSameMonth(day, month) ? 'opacity-20' : report ? 'bg-[var(--series-blue)] text-white hover:opacity-80' : 'cursor-not-allowed bg-[var(--surface-2)] text-[var(--text-muted)]'} ${selected && isSameDay(day, new Date(selected.reportDate)) ? 'ring-2 ring-white' : ''}`}>{format(day, 'd')}</button> })}
        </div>
      </div>
      <article className="min-h-48 rounded-xl bg-[var(--surface-2)] p-4">
        {selected ? <><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{selected.period} · {selected.reportDate}</span><span className="text-xs text-[var(--text-muted)]">{format(new Date(selected.updatedAt), 'dd/MM/yyyy HH:mm')}</span></div><h3 className="mb-3 font-semibold">{selected.title}</h3><div className="whitespace-pre-wrap text-sm leading-6 text-[var(--text-muted)]">{selected.content}</div></> : <p className="text-sm text-[var(--text-muted)]">Selecciona un dia marcat al calendari. Els dies sense informe no es poden obrir.</p>}
      </article>
    </div>
  </section>
}
