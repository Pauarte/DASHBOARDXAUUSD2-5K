import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { DailyPnl } from '../lib/stats'
import { formatDate } from '../lib/format'
import { useCurrencyFormatter } from '../lib/currency'
import { ChartTooltip } from './ChartTooltip'
import { useThemeColors } from '../lib/useThemeColors'

export function DailyPnlChart({ data }: { data: DailyPnl[] }) {
  const colors = useThemeColors()
  const formatCurrency = useCurrencyFormatter()
  const recent = data.slice(-30)
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Daily P&amp;L</h3>
        <span className="text-xs text-[var(--text-muted)]">Last 30 trading days</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={recent} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tickFormatter={(v) => formatDate(v)}
            tick={{ fill: colors.textMuted, fontSize: 11 }}
            stroke={colors.baseline}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v) => `$${Math.round(v)}`}
            tick={{ fill: colors.textMuted, fontSize: 11 }}
            stroke={colors.baseline}
            width={56}
          />
          <Tooltip
            cursor={{ fill: colors.baseline, opacity: 0.15 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const point = payload[0].payload as DailyPnl
              return (
                <ChartTooltip
                  title={formatDate(point.date)}
                  rows={[
                    {
                      label: 'P&L',
                      value: formatCurrency(point.pnl, { signed: true }),
                      color: point.pnl >= 0 ? colors.good : colors.critical,
                    },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="pnl" isAnimationActive={false} radius={[4, 4, 0, 0]} maxBarSize={18}>
            {recent.map((d) => (
              <Cell key={d.date} fill={d.pnl >= 0 ? colors.good : colors.critical} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
