import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient'
import { useAccountData } from '../lib/useAccountData'
import {
  computeStakes,
  unitsForAmount,
  type ContributionRow,
  type ContributionType,
  type PersonStake,
} from '../lib/capitalPool'
import { formatCurrency, formatDateTime, formatPercent } from '../lib/format'

interface ContributionDbRow {
  id: number
  person_name: string
  type: ContributionType
  amount: string | number
  pool_value_before: string | number
  units_before: string | number
  units_delta: string | number
  note: string | null
  created_at: string
}

function mapRow(r: ContributionDbRow): ContributionRow {
  return {
    id: r.id,
    personName: r.person_name,
    type: r.type,
    amount: Number(r.amount),
    poolValueBefore: Number(r.pool_value_before),
    unitsBefore: Number(r.units_before),
    unitsDelta: Number(r.units_delta),
    note: r.note,
    createdAt: r.created_at,
  }
}

export function PartnersPage() {
  const { account, isLive } = useAccountData()

  const [rows, setRows] = useState<ContributionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [personName, setPersonName] = useState('')
  const [type, setType] = useState<ContributionType>('deposit')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    if (!supabase) return
    setLoading(true)
    const { data, error: fetchError } = await supabase
      .from('capital_contributions')
      .select('id, person_name, type, amount, pool_value_before, units_before, units_delta, note, created_at')
      .order('created_at', { ascending: true })

    if (fetchError) {
      setError(fetchError.message)
    } else {
      setRows(((data as ContributionDbRow[] | null) ?? []).map(mapRow))
      setError(null)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalUnits = rows.reduce((s, r) => s + r.unitsDelta, 0)
  const poolValue = isLive ? account.balance : 0
  const stakes = useMemo(() => computeStakes(rows, poolValue), [rows, poolValue])
  const knownNames = useMemo(() => Array.from(new Set(rows.map((r) => r.personName))), [rows])
  const history = useMemo(() => [...rows].reverse(), [rows])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const name = personName.trim()
    const amt = Number(amount)
    if (!name || !(amt > 0)) return

    setSubmitting(true)
    const unitsBefore = totalUnits
    const poolValueBefore = poolValue
    const units = unitsForAmount(amt, poolValueBefore, unitsBefore)
    const unitsDelta = type === 'deposit' ? units : -units

    const { error: insertError } = await supabase.from('capital_contributions').insert({
      person_name: name,
      type,
      amount: amt,
      pool_value_before: poolValueBefore,
      units_before: unitsBefore,
      units_delta: unitsDelta,
      note: note.trim() || null,
    })

    setSubmitting(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    setPersonName('')
    setAmount('')
    setNote('')
    await load()
  }

  async function withdrawAll(person: PersonStake) {
    if (!supabase) return
    if (!confirm(`Retirar tot el capital de ${person.personName} (${formatCurrency(person.currentValue)})?`)) return

    setSubmitting(true)
    await supabase.from('capital_contributions').insert({
      person_name: person.personName,
      type: 'withdrawal',
      amount: Number(person.currentValue.toFixed(2)),
      pool_value_before: poolValue,
      units_before: totalUnits,
      units_delta: -person.units,
      note: 'Retirada completa',
    })
    setSubmitting(false)
    await load()
  }

  async function removeMovement(id: number) {
    if (!supabase) return
    if (!confirm('Eliminar aquest moviment de l’historial?')) return
    setSubmitting(true)
    await supabase.from('capital_contributions').delete().eq('id', id)
    setSubmitting(false)
    await load()
  }

  return (
    <div className="min-h-screen bg-[var(--surface-2)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface-card)]">
        <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Repartiment de capital</h1>
            <p className="text-xs text-[var(--text-muted)]">
              {isLive ? `Pot actual: ${formatCurrency(poolValue)}` : 'Esperant dades del compte…'}
            </p>
          </div>
          <a
            href="/"
            className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] whitespace-nowrap"
          >
            ← Dashboard
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-6 flex flex-col gap-6">
        {!isSupabaseConfigured && (
          <div className="rounded-xl border border-[var(--critical)] bg-[var(--surface-card)] p-4 text-sm text-[var(--critical)]">
            Supabase no està configurat en aquest entorn.
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-[var(--critical)] bg-[var(--surface-card)] p-4 text-sm text-[var(--critical)]">
            {error}
          </div>
        )}

        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Participacions actuals</h2>
          {loading ? (
            <p className="text-sm text-[var(--text-muted)]">Carregant…</p>
          ) : stakes.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Encara no hi ha ningú registrat.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="font-medium py-2 pr-3">Persona</th>
                    <th className="font-medium py-2 pr-3 text-right">Aportat net</th>
                    <th className="font-medium py-2 pr-3 text-right">%</th>
                    <th className="font-medium py-2 pr-3 text-right">Valor actual</th>
                    <th className="font-medium py-2 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {stakes.map((p) => (
                    <tr key={p.personName} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-2 pr-3 font-semibold text-[var(--text-primary)]">{p.personName}</td>
                      <td className="py-2 pr-3 text-right tabular text-[var(--text-secondary)]">
                        {formatCurrency(p.netContributed, { signed: true })}
                      </td>
                      <td className="py-2 pr-3 text-right tabular text-[var(--text-secondary)]">
                        {formatPercent(p.percentage, 1)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular font-semibold text-[var(--text-primary)]">
                        {formatCurrency(p.currentValue)}
                      </td>
                      <td className="py-2 text-right">
                        {p.units > 0 && (
                          <button
                            type="button"
                            disabled={submitting}
                            onClick={() => withdrawAll(p)}
                            className="text-[10px] text-[var(--critical)] hover:underline disabled:opacity-50"
                          >
                            Retirar tot
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[var(--border)] font-semibold">
                    <td className="py-2 pr-3 text-[var(--text-primary)]">Total</td>
                    <td className="py-2 pr-3 text-right tabular">
                      {formatCurrency(stakes.reduce((s, p) => s + p.netContributed, 0), { signed: true })}
                    </td>
                    <td className="py-2 pr-3 text-right tabular">100%</td>
                    <td className="py-2 pr-3 text-right tabular">{formatCurrency(poolValue)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Afegir moviment</h2>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--text-muted)]">Persona</label>
                <input
                  list="known-names"
                  value={personName}
                  onChange={(e) => setPersonName(e.target.value)}
                  placeholder="Nom"
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
                  required
                />
                <datalist id="known-names">
                  {knownNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--text-muted)]">Tipus</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as ContributionType)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
                >
                  <option value="deposit">Aportació (entra diners)</option>
                  <option value="withdrawal">Retirada (surt diners)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--text-muted)]">Import (USD)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm tabular"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--text-muted)]">Nota (opcional)</label>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder=""
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting || !isLive}
              className="self-start rounded-lg bg-[var(--series-blue)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? 'Desant…' : 'Afegir moviment'}
            </button>
            {!isLive && (
              <p className="text-xs text-[var(--text-muted)]">
                Cal que el compte tingui dades en directe abans de poder afegir moviments (calen per calcular el valor del pot).
              </p>
            )}
          </form>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Historial de moviments</h2>
          {history.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Cap moviment encara.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="font-medium py-2 pr-3">Data</th>
                    <th className="font-medium py-2 pr-3">Persona</th>
                    <th className="font-medium py-2 pr-3">Tipus</th>
                    <th className="font-medium py-2 pr-3 text-right">Import</th>
                    <th className="font-medium py-2 pr-3 text-right">Pot en aquell moment</th>
                    <th className="font-medium py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-2 pr-3 tabular whitespace-nowrap text-[var(--text-secondary)]">
                        {formatDateTime(r.createdAt)}
                      </td>
                      <td className="py-2 pr-3 text-[var(--text-primary)]">{r.personName}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={
                            r.type === 'deposit'
                              ? 'text-[var(--good-text)]'
                              : 'text-[var(--critical)]'
                          }
                        >
                          {r.type === 'deposit' ? 'Aportació' : 'Retirada'}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular">
                        {formatCurrency(r.type === 'withdrawal' ? -r.amount : r.amount, { signed: true })}
                      </td>
                      <td className="py-2 pr-3 text-right tabular text-[var(--text-secondary)]">
                        {formatCurrency(r.poolValueBefore)}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => removeMovement(r.id)}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--critical)] disabled:opacity-50"
                        >
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
