import type { TechnicalTelemetry } from '../lib/types'
import { formatDateTime, formatPercent } from '../lib/format'
import { useCurrencyFormatter } from '../lib/currency'

function number(value: number | null, decimals = 2): string {
  return value === null ? '—' : value.toFixed(decimals)
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular text-[var(--text-primary)]">{value}</div>
    </div>
  )
}

export function TechnicalTelemetryCard({ telemetry }: { telemetry: TechnicalTelemetry | null }) {
  const formatCurrency = useCurrencyFormatter()
  return (
    <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <summary className="cursor-pointer select-none text-sm font-semibold text-[var(--text-primary)]">
        Telemetria tècnica per a l’anàlisi
        <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
          {telemetry ? `actualitzada ${formatDateTime(telemetry.updatedAt)}` : 'pendent de migració'}
        </span>
      </summary>

      {!telemetry ? (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          El dashboard continua funcionant, però la capa privada de telemetria encara no ha publicat el primer resum.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Drawdown global" value={formatPercent(telemetry.drawdownPct, 2)} />
            <Metric label="Drawdown intradia" value={formatPercent(telemetry.intradayDrawdownPct, 2)} />
            <Metric label="Límit floating utilitzat" value={formatPercent(telemetry.floatingLimitUsedPct, 1)} />
            <Metric label="Cap de lots utilitzat" value={formatPercent(telemetry.lotLimitUsedPct, 1)} />
            <Metric label="Spread" value={`${number(telemetry.spreadPoints, 1)} punts`} />
            <Metric label="Spread / ATR" value={number(telemetry.spreadAtrRatio, 3)} />
            <Metric label="ATR M1 / M5" value={`${number(telemetry.atrM1)} / ${number(telemetry.atrM5)}`} />
            <Metric label="RSI / ADX M1" value={`${number(telemetry.rsiM1, 1)} / ${number(telemetry.adxM1, 1)}`} />
            <Metric label="Moviment 5 / 15 min" value={`${number(telemetry.recentMove5m)} / ${number(telemetry.recentMove15m)}`} />
            <Metric label="Moviment 60 min" value={number(telemetry.recentMove60m)} />
            <Metric label="Lot base efectiu" value={telemetry.effectiveBaseLot.toFixed(2)} />
            <Metric label="Cap total efectiu" value={telemetry.effectiveMaxTotalLot.toFixed(2)} />
            <Metric
              label="Stop floating efectiu"
              value={formatCurrency(-telemetry.effectiveMaxFloatingLoss)}
            />
            <Metric label="Marge lliure" value={formatCurrency(telemetry.marginFree)} />
            <Metric label="Nivell de marge" value={`${telemetry.marginLevel.toFixed(0)} %`} />
            <Metric label="Durada del sync" value={`${telemetry.syncDurationMs} ms`} />
          </div>

          <div className="flex flex-wrap gap-2 text-xs">
            <span className={`rounded-full px-2 py-1 ${telemetry.newsBlockActive ? 'bg-amber-500/15 text-amber-300' : 'bg-[var(--surface-2)] text-[var(--text-muted)]'}`}>
              Notícies: {telemetry.newsBlockActive ? telemetry.newsBlockReason ?? 'bloqueig actiu' : 'sense bloqueig'}
            </span>
            <span className={`rounded-full px-2 py-1 ${telemetry.rolloverBlockActive ? 'bg-amber-500/15 text-amber-300' : 'bg-[var(--surface-2)] text-[var(--text-muted)]'}`}>
              Rollover: {telemetry.rolloverBlockActive ? 'bloqueig actiu' : 'fora de la finestra'}
            </span>
            <span className="rounded-full bg-[var(--surface-2)] px-2 py-1 text-[var(--text-muted)]">
              Versió: {telemetry.botVersionKey}
            </span>
          </div>
        </div>
      )}
    </details>
  )
}
