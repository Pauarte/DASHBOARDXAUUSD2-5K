import { useEffect, useMemo, useState } from 'react'
import { buildDailyPnl, buildEquityCurve, computeStats } from './lib/stats'
import { formatCurrency, formatDateTime, formatPercent } from './lib/format'
import { useAccountData } from './lib/useAccountData'
import { StatTile } from './components/StatTile'
import { EquityCurveChart } from './components/EquityCurveChart'
import { DrawdownChart } from './components/DrawdownChart'
import { DailyPnlChart } from './components/DailyPnlChart'
import { TradeHistoryTable } from './components/TradeHistoryTable'
import { OpenPositionsCard } from './components/OpenPositionsCard'
import { CalendarHeatmap } from './components/CalendarHeatmap'

function App() {
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

  const { trades, openPositions, account, isLive, loading, worstFloating } = useAccountData()

  const stats = useMemo(() => computeStats(trades, account.startBalance), [trades, account.startBalance])
  const floatingPnl = useMemo(
    () => openPositions.reduce((sum, p) => sum + p.floatingPnl, 0),
    [openPositions],
  )
  const equityCurve = useMemo(
    () => buildEquityCurve(trades, account.startBalance),
    [trades, account.startBalance],
  )
  const dailyPnl = useMemo(() => buildDailyPnl(trades), [trades])

  const totalReturnPct = ((account.balance - account.startBalance) / account.startBalance) * 100

  return (
    <div className="min-h-screen bg-[var(--surface-2)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface-card)]">
        <div className="max-w-6xl mx-auto px-6 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Monitor Bots Trading</h1>
            <p className="text-xs text-[var(--text-muted)]">
              {loading
                ? 'Loading…'
                : isLive
                  ? 'Connected to Supabase — live data'
                  : 'Demo data — waiting for the sync script to write real trades'}
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
              {formatPercent(totalReturnPct, 1)} since {formatCurrency(account.startBalance)} start
            </div>
          </div>
        </div>
      </header>
      {installPrompt && <button onClick={installApp} className="fixed bottom-4 right-4 z-10 rounded-full border border-[var(--border)] bg-[var(--surface-card)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] shadow-lg hover:text-[var(--text-primary)]">Instal·lar app</button>}

      <main className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-6">
        <section className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatTile label="Balance" value={formatCurrency(account.balance)} />
          <StatTile
            label="Floating P&L"
            value={formatCurrency(floatingPnl, { signed: true })}
            sub={`${openPositions.length} open`}
            tone={floatingPnl >= 0 ? 'good' : 'critical'}
          />
          <StatTile
            label="Worst floating ever"
            value={worstFloating ? formatCurrency(worstFloating.value, { signed: true }) : '—'}
            sub={worstFloating ? formatDateTime(worstFloating.at) : 'Tracking starts now'}
            tone="critical"
          />
          <StatTile
            label="Today's P&L"
            value={formatCurrency(stats.todayPnl, { signed: true })}
            tone={stats.todayPnl >= 0 ? 'good' : 'critical'}
          />
          <StatTile
            label="Total trades"
            value={stats.totalTrades.toString()}
            sub={`${stats.wins}W / ${stats.losses}L / ${stats.breakEvens}BE`}
          />
          <StatTile label="Win rate" value={formatPercent(stats.winRate)} />
          <StatTile
            label="Max drawdown"
            value={formatPercent(stats.maxDrawdownPct)}
            sub={formatCurrency(stats.maxDrawdownMoney)}
            tone="critical"
          />
          <StatTile
            label="Best / worst trade"
            value={formatCurrency(stats.bestTrade, { signed: true })}
            sub={formatCurrency(stats.worstTrade, { signed: true })}
          />
          <StatTile
            label="Avg win / loss"
            value={formatCurrency(stats.avgWin, { signed: true })}
            sub={formatCurrency(-stats.avgLoss, { signed: true })}
          />
          <StatTile
            label="Total P&L"
            value={formatCurrency(stats.totalPnl, { signed: true })}
            tone={stats.totalPnl >= 0 ? 'good' : 'critical'}
          />
        </section>

        <EquityCurveChart data={equityCurve} />

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <DrawdownChart data={equityCurve} />
          <DailyPnlChart data={dailyPnl} />
        </section>

        <CalendarHeatmap trades={trades} />

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2">
            <TradeHistoryTable trades={trades} />
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
