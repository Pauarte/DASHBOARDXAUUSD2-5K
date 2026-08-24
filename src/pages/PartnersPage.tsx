import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient'
import { useAccountData } from '../lib/useAccountData'
import {
  computeStakes,
  mapContributionRow,
  personDailyReturnPct,
  personTodayChange,
  personValueOverTime,
  scaleTradesForPerson,
  unitsForAmount,
  type ContributionDbRow,
  type ContributionRow,
  type ContributionType,
  type PersonStake,
} from '../lib/capitalPool'
import { buildDailyPnl, groupIntoBaskets } from '../lib/stats'
import { formatDateTime, formatPercent } from '../lib/format'
import { useCurrencyFormatter } from '../lib/currency'
import { ALL_TIME, filterByCloseTime, type DateRange } from '../lib/dateRange'
import type { PartnerIdentity } from '../lib/partnersAuth'
import { StatTile } from '../components/StatTile'
import { PersonalValueChart } from '../components/PersonalValueChart'
import { PasswordGate } from '../components/PasswordGate'
import { DailyPnlChart } from '../components/DailyPnlChart'
import { CalendarHeatmap } from '../components/CalendarHeatmap'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { DateRangeFilter } from '../components/DateRangeFilter'

export function PartnersPage() {
  return (
    <PasswordGate title="Repartiment de capital" subtitle="Introdueix la teva contrasenya per entrar.">
      {(identity, onLogout) => <PartnersDashboard identity={identity} onLogout={onLogout} />}
    </PasswordGate>
  )
}

function PartnersDashboard({ identity, onLogout }: { identity: PartnerIdentity; onLogout: () => void }) {
  const formatCurrency = useCurrencyFormatter()
  const { account, isLive, trades, openPositions, floatingHistory: balanceHistory } = useAccountData()
  const floatingTotal = openPositions.reduce((s, p) => s + p.floatingPnl, 0)

  const [rows, setRows] = useState<ContributionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Every stat/chart below is scoped to this — defaults to all-time.
  const [dateRange, setDateRange] = useState<DateRange>(ALL_TIME)
  const filteredTrades = useMemo(() => filterByCloseTime(trades, dateRange), [trades, dateRange])
  const [personName, setPersonName] = useState(identity.isAdmin ? '' : identity.personName)
  const [type, setType] = useState<ContributionType>('deposit')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    if (!supabase) return
    setLoading(true)
    const contributionsRes = await supabase
      .from('capital_contributions')
      .select('id, person_name, type, amount, pool_value_before, units_before, units_delta, note, created_at')
      .order('created_at', { ascending: true })

    if (contributionsRes.error) {
      setError(contributionsRes.error.message)
    } else {
      setRows(((contributionsRes.data as ContributionDbRow[] | null) ?? []).map(mapContributionRow))
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
  const allStakes = useMemo(() => computeStakes(rows, poolValue), [rows, poolValue])
  const stakes = identity.isAdmin ? allStakes : allStakes.filter((s) => s.personName === identity.personName)
  const knownNames = useMemo(() => Array.from(new Set(rows.map((r) => r.personName))), [rows])
  const allHistory = useMemo(() => [...rows].reverse(), [rows])
  const history = identity.isAdmin ? allHistory : allHistory.filter((r) => r.personName === identity.personName)

  const myStake = allStakes.find((s) => s.personName === identity.personName) ?? null
  const myValueHistory = useMemo(
    () => personValueOverTime(rows, identity.personName, balanceHistory),
    [rows, identity.personName, balanceHistory],
  )
  const myGainLoss = myStake ? myStake.currentValue - myStake.netContributed : 0
  const myTodayChange = myStake ? personTodayChange(myValueHistory, myStake.currentValue) : { pnl: 0, pct: 0 }
  const myFloating = myStake ? (floatingTotal * myStake.percentage) / 100 : 0
  const myTrades = useMemo(
    () => scaleTradesForPerson(filteredTrades, rows, identity.personName),
    [filteredTrades, rows, identity.personName],
  )
  const dailyPnl = useMemo(() => buildDailyPnl(myTrades), [myTrades])
  const personalBasketStats = useMemo(() => {
    const personalPnlByClose = new Map(
      groupIntoBaskets(myTrades).map((basket) => [basket.closeTime, basket.pnl]),
    )
    const baskets = groupIntoBaskets(filteredTrades).flatMap((basket) => {
      const pnl = personalPnlByClose.get(basket.closeTime)
      return pnl === undefined ? [] : [{ pnl, isWin: basket.isWin, isLoss: basket.isLoss }]
    })
    const wins = baskets.filter((basket) => basket.isWin)
    const losses = baskets.filter((basket) => basket.isLoss)
    const breakEvens = baskets.length - wins.length - losses.length
    const decided = wins.length + losses.length

    return {
      total: baskets.length,
      wins: wins.length,
      losses: losses.length,
      breakEvens,
      winRate: decided > 0 ? (wins.length / decided) * 100 : 0,
      best: baskets.length ? Math.max(...baskets.map((basket) => basket.pnl)) : 0,
      worst: baskets.length ? Math.min(...baskets.map((basket) => basket.pnl)) : 0,
      avgWin: wins.length ? wins.reduce((sum, basket) => sum + basket.pnl, 0) / wins.length : 0,
      avgLoss: losses.length ? Math.abs(losses.reduce((sum, basket) => sum + basket.pnl, 0)) / losses.length : 0,
    }
  }, [filteredTrades, myTrades])
  const myDailyPct = useMemo(
    () => personDailyReturnPct(dailyPnl, myValueHistory),
    [dailyPnl, myValueHistory],
  )
  // Own share, day by day — not the whole bot's raw average, which ignores
  // dilution from other partners' deposits/withdrawals on any given day.
  const myAvgDailyReturnPct = useMemo(() => {
    const pcts = Array.from(myDailyPct.values())
    return pcts.length > 0 ? pcts.reduce((s, p) => s + p, 0) / pcts.length : 0
  }, [myDailyPct])

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
              Connectat com a <span className="font-semibold">{identity.personName}</span>
              {identity.isAdmin ? ' (veus tothom)' : ''}
              {' · '}
              {isLive ? `Pot actual: ${formatCurrency(poolValue)}` : 'Esperant dades del compte…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onLogout}
              className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] whitespace-nowrap"
            >
              Sortir
            </button>
            <a
              href="/"
              className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] whitespace-nowrap"
            >
              ← Dashboard
            </a>
            <CurrencyToggle />
          </div>
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

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">El teu dashboard</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatTile
              label="Aportat net"
              value={myStake ? formatCurrency(myStake.netContributed, { signed: true }) : '—'}
            />
            <StatTile label="Valor actual" value={myStake ? formatCurrency(myStake.currentValue) : '—'} />
            <StatTile
              label="P&L d'avui"
              value={myStake ? formatCurrency(myTodayChange.pnl, { signed: true }) : '—'}
              tone={myTodayChange.pnl >= 0 ? 'good' : 'critical'}
            />
            <StatTile
              label="% fet avui"
              value={myStake ? formatPercent(myTodayChange.pct, 2) : '—'}
              tone={myTodayChange.pct >= 0 ? 'good' : 'critical'}
            />
            <StatTile
              label="Guany / pèrdua"
              value={myStake ? formatCurrency(myGainLoss, { signed: true }) : '—'}
              tone={myGainLoss >= 0 ? 'good' : 'critical'}
            />
            <StatTile
              label="El teu floating"
              value={myStake ? formatCurrency(myFloating, { signed: true }) : '—'}
              sub={`${openPositions.length} posicions obertes`}
              tone={myFloating >= 0 ? 'good' : 'critical'}
            />
          </div>
          <PersonalValueChart data={myValueHistory} />

          <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
            <p className="text-xs text-[var(--text-muted)]">
              La teva part de cada mètrica del bot, segons el teu {formatPercent(myStake?.percentage ?? 0, 1)}
            </p>
            <DateRangeFilter range={dateRange} onChange={setDateRange} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatTile
              label="Operacions tancades"
              value={personalBasketStats.total.toString()}
              sub={`${personalBasketStats.wins}W / ${personalBasketStats.losses}L / ${personalBasketStats.breakEvens}BE`}
            />
            <StatTile label="Win rate" value={formatPercent(personalBasketStats.winRate)} />
            <StatTile
              label="Mitjana diària"
              value={formatPercent(myAvgDailyReturnPct, 2)}
              tone={myAvgDailyReturnPct >= 0 ? 'good' : 'critical'}
            />
            <StatTile
              label="Millor / pitjor cistella"
              value={formatCurrency(personalBasketStats.best, { signed: true })}
              sub={formatCurrency(personalBasketStats.worst, { signed: true })}
            />
            <StatTile
              label="Mitjana guany / pèrdua"
              value={formatCurrency(personalBasketStats.avgWin, { signed: true })}
              sub={formatCurrency(-personalBasketStats.avgLoss, { signed: true })}
            />
          </div>
          <DailyPnlChart data={dailyPnl} />
          <CalendarHeatmap trades={myTrades} dailyPct={myDailyPct} />
        </section>

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
                        {identity.isAdmin && p.units > 0 && (
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
                {identity.isAdmin && (
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
                )}
              </table>
            </div>
          )}
        </section>

        {identity.isAdmin && (
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
                  disabled={!identity.isAdmin}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm disabled:opacity-70"
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
        )}

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
                    {identity.isAdmin && <th className="font-medium py-2"></th>}
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
                      {identity.isAdmin && (
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
                      )}
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
