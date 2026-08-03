import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { PersonValuePoint } from '../lib/capitalPool'
import { formatDateTime } from '../lib/format'
import { useCurrencyFormatter, useCurrencySymbolFormatter } from '../lib/currency'
import { ChartTooltip } from './ChartTooltip'
import { useThemeColors } from '../lib/useThemeColors'

export function PersonalValueChart({ data }: { data: PersonValuePoint[] }) {
  const colors = useThemeColors()
  const formatCurrency = useCurrencyFormatter()
  const formatAxisCurrency = useCurrencySymbolFormatter()

  if (data.length < 2) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">El teu valor en el temps</h3>
        <p className="text-sm text-[var(--text-muted)]">Encara no hi ha prou historial per dibuixar el gràfic.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">El teu valor en el temps</h3>
        <span className="text-xs text-[var(--text-muted)]">Segons la teva % de participació en cada moment</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="personalValueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.seriesBlue} stopOpacity={0.18} />
              <stop offset="100%" stopColor={colors.seriesBlue} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="time"
            tickFormatter={(v) => formatDateTime(v).split(',')[0]}
            tick={{ fill: colors.textMuted, fontSize: 11 }}
            stroke={colors.baseline}
            minTickGap={40}
          />
          <YAxis
            domain={['dataMin - 10', 'dataMax + 10']}
            tickFormatter={formatAxisCurrency}
            tick={{ fill: colors.textMuted, fontSize: 11 }}
            stroke={colors.baseline}
            width={64}
          />
          <Tooltip
            cursor={{ stroke: colors.baseline, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const point = payload[0].payload as PersonValuePoint
              return (
                <ChartTooltip
                  title={formatDateTime(label as string)}
                  rows={[{ label: 'Valor', value: formatCurrency(point.value), color: colors.seriesBlue }]}
                />
              )
            }}
          />
          <Area
            isAnimationActive={false}
            type="monotone"
            dataKey="value"
            stroke={colors.seriesBlue}
            strokeWidth={2}
            fill="url(#personalValueFill)"
            dot={false}
            activeDot={{ r: 4, fill: colors.seriesBlue, stroke: colors.surfaceCard, strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
