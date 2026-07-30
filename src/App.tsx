import { useEffect, useMemo, useState } from 'react'
import { buildDailyPnl, buildEquityCurve, computeStats } from './lib/stats'
import { formatCurrency, formatDateTime, formatPercent } from './lib/format'
import { useAccountData } from './lib/useAccountData'
import { StatTile } from './components/StatTile'
import { EquityCurveChart } from './components/EquityCurveChart'
import { DailyPnlChart } from './components/DailyPnlChart'
import { TradeHistoryTable } from './components/TradeHistoryTable'
import { OpenPositionsCard } from './components/OpenPositionsCard'
import { CalendarHeatmap } from './components/CalendarHeatmap'
import { ConnectionStatus } from './components/ConnectionStatus'
import { useConnectionAlerts } from './lib/useConnectionAlerts'
import { PasswordGate } from './components/PasswordGate'
import type { PartnerIdentity } from './lib/partnersAuth'

function App() {
  return (
    <PasswordGate title="Monitor Bots Trading" subtitle="Introdueix la contrasenya per entrar.">
      {(identity, onLogout) => <Dashboard identity={identity} onLogout={onLogout} />}
    </PasswordGate>
  )
}

function Dashboard({ identity, onLogout }: { identity: PartnerIdentity; onLogout: () => void }) {
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
    worstFloating,
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

  const stats = useMemo(() => computeStats(trades, account.startBalance), [trades, account.startBalance])
  const floatingPnl = account.equity - account.balance
  // Real trading P&L: balance minus everything partners have ever put in
  // or taken out (from /socis), not the bot's fixed genesis balance — so
  // a partner deposit/withdrawal never shows up as a fake sync gap here.
  const accountTotalPnl = account.balance - totalNetCapital
  const historyGap = Number((accountTotalPnl - stats.totalPnl).toFixed(2))
  const hasHistoryGap = isLive && Math.abs(historyGap) >= 0.01
  // Bridge to a "current" point using the capital-adjusted balance (genesis
  // + real trading P&L), not the raw account balance — otherwise a partner
  // deposit/withdrawal shows up as a fake jump on the profit curve.
  const capitalAdjustedBalance = account.startBalance + accountTotalPnl
  const equityCurve = useMemo(
    () => buildEquityCurve(trades, account.startBalance, capitalAdjustedBalance, lastSyncAt),
    [trades, account.startBalance, capitalAdjustedBalance, lastSyncAt],
  )
  const dailyPnl = useMemo(() => buildDailyPnl(trades), [trades])

  const totalReturnPct = ((account.balance - totalNetCapital) / totalNetCapital) * 100

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

        <section className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatTile label="Balance" value={formatCurrency(account.balance)} />
          <StatTile
            label="Floating P&L"
            value={formatCurrency(floatingPnl, { signed: true })}
            sub={`${openPositions.length} posicions obertes`}
            tone={floatingPnl >= 0 ? 'good' : 'critical'}
          />
          <StatTile
            label="Pitjor floating registrat"
            value={worstFloating ? formatPercent(worstFloating.pct, 0) : '—'}
            sub={
              worstFloating
                ? `${formatCurrency(worstFloating.value, { signed: true })} · ${formatDateTime(worstFloating.at)}`
                : 'Encara sense dades'
            }
            tone="critical"
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
            value={formatPercent(stats.avgDailyReturnPct, 2)}
            tone={stats.avgDailyReturnPct >= 0 ? 'good' : 'critical'}
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

        <EquityCurveChart data={equityCurve} />

        <DailyPnlChart data={dailyPnl} />

        <CalendarHeatmap trades={trades} />

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2">
            <TradeHistoryTable trades={trades} floatingHistory={floatingHistory} />
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
