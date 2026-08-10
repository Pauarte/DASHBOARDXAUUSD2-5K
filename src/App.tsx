import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { buildDailyPnl, buildEquityCurve, computeStats } from './lib/stats'
import { formatPercent, dashboardDateKey } from './lib/format'
import { useCurrencyFormatter } from './lib/currency'
import { floatingSeverityPct } from './lib/floatingRisk'
import { useAccountData } from './lib/useAccountData'
import { supabase } from './lib/supabaseClient'
import {
  mapContributionRow,
  personDailyReturnPct,
  personValueOverTime,
  scaleTradesForPerson,
  type ContributionRow,
} from './lib/capitalPool'
import { ALL_TIME, balanceAtRangeStart, filterByCloseTime, filterByRecordedAt, type DateRange } from './lib/dateRange'
import { StatTile } from './components/StatTile'
import { TradeHistoryTable } from './components/TradeHistoryTable'
import { OpenPositionsCard } from './components/OpenPositionsCard'
import { CalendarHeatmap } from './components/CalendarHeatmap'
import { ConnectionStatus } from './components/ConnectionStatus'
import { CurrencyToggle } from './components/CurrencyToggle'
import { DateRangeFilter } from './components/DateRangeFilter'
import { useConnectionAlerts } from './lib/useConnectionAlerts'
import { PasswordGate } from './components/PasswordGate'
import type { PartnerIdentity } from './lib/partnersAuth'

// Recharts alone accounts for most of this app's JS weight. The stats
// tiles, table and connection status above don't need it at all, so
// lazy-loading just these two keeps the numbers on screen instantly while
// the chart chunk streams in behind them, instead of the whole page
// waiting on a ~600kB chunk before anything is visible.
const EquityCurveChart = lazy(() => import('./components/EquityCurveChart').then((m) => ({ default: m.EquityCurveChart })))
const DailyPnlChart = lazy(() => import('./components/DailyPnlChart').then((m) => ({ default: m.DailyPnlChart })))

function ChartSkeleton() {
  return (
    <div className="h-64 rounded-xl border border-[var(--border)] bg-[var(--surface-card)] animate-pulse" />
  )
}

function App() {
  return (
    <PasswordGate title="Monitor Bots Trading" subtitle="Introdueix la contrasenya per entrar.">
      {(identity, onLogout) => <Dashboard identity={identity} onLogout={onLogout} />}
    </PasswordGate>
  )
}

function Dashboard({ identity, onLogout }: { identity: PartnerIdentity; onLogout: () => void }) {
  const formatCurrency = useCurrencyFormatter()
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function installApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    setInstallPrompt(null)
  }

  const {
    trades,
    openPositions,
    account,
    isLive,
    loading,
    floatingHistory,
    totalNetCapital,
    lastSyncAt,
    isStale,
    syncAgeSeconds,
    lastCheckedAt,
    connectionError,
  } = useAccountData()
  const hasConnectionAlert = isLive && (isStale || Boolean(connectionError))
  const connectionAlertBody = connectionError
    ? 'No s’ha pogut consultar Supabase. El monitor conserva les últimes dades rebudes.'
    : 'Fa més de 3 minuts que no arriben dades noves del bot.'
  const {
    alertsEnabled,
    permission: alertPermission,
    requestAlerts,
    disableAlerts,
  } = useConnectionAlerts(hasConnectionAlert, isLive, connectionAlertBody)

  useEffect(() => {
    document.title = hasConnectionAlert ? '[ALERTA] Monitor Bots Trading' : 'Monitor Bots Trading'
  }, [hasConnectionAlert])

  // Every stat/chart below is scoped to this — defaults to all-time.
  const [dateRange, setDateRange] = useState<DateRange>(ALL_TIME)
  const isRangeOpenEnded = !dateRange.end || dateRange.end >= dashboardDateKey(new Date().toISOString())
  const filteredTrades = useMemo(() => filterByCloseTime(trades, dateRange), [trades, dateRange])
  const filteredFloatingHistory = useMemo(
    () => filterByRecordedAt(floatingHistory, dateRange),
    [floatingHistory, dateRange],
  )
  // The real balance the period actually started with, not the account's
  // all-time genesis balance — otherwise a "last 7 days" filter would base
  // % returns/drawdown off months of unrelated prior growth.
  const periodStartBalance = useMemo(
    () => balanceAtRangeStart(floatingHistory, dateRange, account.startBalance),
    [floatingHistory, dateRange, account.startBalance],
  )

  const stats = useMemo(
    () => computeStats(filteredTrades, periodStartBalance, filteredFloatingHistory),
    [filteredTrades, periodStartBalance, filteredFloatingHistory],
  )
  // "Mitjana diària" here is Arte's own personal daily return (same
  // fund-unit math as /socis), not the whole bot's raw average — the
  // bot's own number ignores dilution from partner deposits/withdrawals,
  // and the ask was for the total dashboard to just mirror what Arte sees.
  const [contributionRows, setContributionRows] = useState<ContributionRow[]>([])
  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    supabase
      .from('capital_contributions')
      .select('id, person_name, type, amount, pool_value_before, units_before, units_delta, note, created_at')
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        setContributionRows(data.map(mapContributionRow))
      })
    return () => {
      cancelled = true
    }
  }, [])
  const arteDailyPct = useMemo(() => {
    // Full (unfiltered) history for the value series — it needs everything
    // before the range too, to know Arte's real value the moment the
    // period started. Only which days show up comes from filteredTrades.
    const arteTrades = scaleTradesForPerson(filteredTrades, contributionRows, 'Arte')
    const arteValueHistory = personValueOverTime(contributionRows, 'Arte', floatingHistory)
    return personDailyReturnPct(buildDailyPnl(arteTrades), arteValueHistory)
  }, [filteredTrades, contributionRows, floatingHistory])
  const arteAvgDailyReturnPct = useMemo(() => {
    const pcts = Array.from(arteDailyPct.values())
    return pcts.length > 0 ? pcts.reduce((s, p) => s + p, 0) / pcts.length : 0
  }, [arteDailyPct])
  const floatingPnl = account.equity - account.balance
  // Real trading P&L: balance minus everything partners have ever put in
  // or taken out (from /socis), not the bot's fixed genesis balance — so
  // a partner deposit/withdrawal never shows up as a fake sync gap here.
  const accountTotalPnl = account.balance - totalNetCapital
  const historyGap = Number((accountTotalPnl - stats.totalPnl).toFixed(2))
  const hasHistoryGap = isLive && !dateRange.start && !dateRange.end && Math.abs(historyGap) >= 0.01
  // Bridge to a "current" point using the capital-adjusted balance (genesis
  // + real trading P&L), not the raw account balance — otherwise a partner
  // deposit/withdrawal shows up as a fake jump on the profit curve. Only
  // makes sense when the filtered range actually reaches today; a closed
  // historical range just ends at its last trade.
  const capitalAdjustedBalance = account.startBalance + accountTotalPnl
  const equityCurve = useMemo(
    () =>
      buildEquityCurve(
        filteredTrades,
        periodStartBalance,
        isRangeOpenEnded ? capitalAdjustedBalance : undefined,
        isRangeOpenEnded ? lastSyncAt : undefined,
      ),
    [filteredTrades, periodStartBalance, isRangeOpenEnded, capitalAdjustedBalance, lastSyncAt],
  )
  const dailyPnl = useMemo(() => buildDailyPnl(filteredTrades), [filteredTrades])

  const totalReturnPct = ((account.balance - totalNetCapital) / totalNetCapital) * 100

  if (loading && !lastSyncAt) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--surface-2)]">
        <div className="text-center text-sm text-[var(--text-muted)]">
          <div className="mb-3 h-8 w-8 mx-auto rounded-full border-2 border-[var(--border)] border-t-transparent animate-spin" />
          Carregant dades reals del bot…
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--surface-2)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface-card)]">
        <div className="max-w-6xl mx-auto px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold">Monitor Bots Trading</h1>
              <a
                href="/socis"
                className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
              >
                Repartiment de capital
              </a>
              <a
                href="/analisis"
                className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
              >
                Anàlisi diària
              </a>
              <button
                type="button"
                onClick={onLogout}
                className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
              >
                Sortir
              </button>
              <CurrencyToggle />
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Connectat com a <span className="font-semibold">{identity.personName}</span>
              {' · '}
              {loading
                ? 'Carregant…'
                : isLive
                  ? 'Dades reals de MT5 sincronitzades mitjançant Supabase'
                  : 'Esperant que el sincronitzador publiqui dades reals'}
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Account equity</div>
            <div className="tabular text-3xl font-semibold">{formatCurrency(account.equity)}</div>
            <div
              className={`text-xs font-medium ${
                totalReturnPct >= 0 ? 'text-[var(--good-text)]' : 'text-[var(--critical)]'
              }`}
            >
              {formatPercent(totalReturnPct, 1)} since {formatCurrency(totalNetCapital)} invested
            </div>
          </div>
        </div>
      </header>
      {connectionError && (
        <div
          className="border-b border-red-700/40 bg-red-950/50 px-6 py-3 text-center text-sm text-red-100"
          role="alert"
        >
          No s’ha pogut consultar Supabase. Es conserven les últimes dades rebudes.
        </div>
      )}
      {!connectionError && isLive && isStale && (
        <div
          className="border-b border-amber-700/40 bg-amber-950/40 px-6 py-3 text-center text-sm text-amber-100"
          role="alert"
        >
          Fa més de 3 minuts que no arriben dades noves. Els valors poden estar desactualitzats.
        </div>
      )}
      {hasHistoryGap && (
        <div
          className="border-b border-amber-700/40 bg-amber-950/30 px-6 py-3 text-center text-sm text-amber-100"
          role="status"
        >
          L’historial d’operacions no quadra amb el balance real. Diferència pendent de
          sincronitzar: {formatCurrency(historyGap, { signed: true })}.
        </div>
      )}
      {installPrompt && <button onClick={installApp} className="fixed bottom-4 right-4 z-10 rounded-full border border-[var(--border)] bg-[var(--surface-card)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] shadow-lg hover:text-[var(--text-primary)]">Instal·lar app</button>}

      <main className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-6">
        <ConnectionStatus
          loading={loading}
          isLive={isLive}
          isStale={isStale}
          syncAgeSeconds={syncAgeSeconds}
          lastSyncAt={lastSyncAt}
          lastCheckedAt={lastCheckedAt}
          connectionError={connectionError}
          alertsEnabled={alertsEnabled}
          permission={alertPermission}
          onEnableAlerts={() => void requestAlerts()}
          onDisableAlerts={disableAlerts}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Estadístiques</h2>
          <DateRangeFilter range={dateRange} onChange={setDateRange} />
        </div>

        <section className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatTile label="Balance" value={formatCurrency(account.balance)} />
          <StatTile
            label="Floating P&L"
            value={formatPercent(floatingSeverityPct(floatingPnl, account.balance), 0)}
            sub={`${formatCurrency(floatingPnl, { signed: true })} · ${openPositions.length} posicions obertes`}
            tone={floatingPnl >= 0 ? 'good' : 'critical'}
          />
          <StatTile
            label="P&L d’avui"
            value={formatCurrency(stats.todayPnl, { signed: true })}
            tone={stats.todayPnl >= 0 ? 'good' : 'critical'}
          />
          <StatTile
            label="Operacions tancades"
            value={stats.totalTrades.toString()}
            sub={`${stats.wins}W / ${stats.losses}L / ${stats.breakEvens}BE`}
          />
          <StatTile label="Win rate" value={formatPercent(stats.winRate)} />
          <StatTile
            label="Mitjana diària"
            value={formatPercent(arteAvgDailyReturnPct, 2)}
            tone={arteAvgDailyReturnPct >= 0 ? 'good' : 'critical'}
          />
          <StatTile
            label="Millor / pitjor cistella"
            value={formatCurrency(stats.bestTrade, { signed: true })}
            sub={formatCurrency(stats.worstTrade, { signed: true })}
          />
          <StatTile
            label="Mitjana guany / pèrdua"
            value={formatCurrency(stats.avgWin, { signed: true })}
            sub={formatCurrency(-stats.avgLoss, { signed: true })}
          />
          <StatTile
            label="P&L total real"
            value={formatCurrency(accountTotalPnl, { signed: true })}
            sub={
              hasHistoryGap
                ? `${formatCurrency(stats.totalPnl, { signed: true })} identificat`
                : 'Quadra amb l’historial'
            }
            tone={accountTotalPnl >= 0 ? 'good' : 'critical'}
          />
        </section>

        <Suspense fallback={<ChartSkeleton />}>
          <EquityCurveChart data={equityCurve} />
        </Suspense>

        <Suspense fallback={<ChartSkeleton />}>
          <DailyPnlChart data={dailyPnl} />
        </Suspense>

        <CalendarHeatmap trades={filteredTrades} dailyPct={arteDailyPct} />

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2">
            <TradeHistoryTable trades={filteredTrades} floatingHistory={floatingHistory} />
          </div>
          <OpenPositionsCard positions={openPositions} />
        </section>
      </main>
    </div>
  )
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

export default App
