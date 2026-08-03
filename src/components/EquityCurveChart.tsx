import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { EquityPoint } from '../lib/stats'
import { formatDateTime } from '../lib/format'
import { useCurrencyFormatter, useCurrencySymbolFormatter } from '../lib/currency'
import { ChartTooltip } from './ChartTooltip'
import { useThemeColors } from '../lib/useThemeColors'

export function EquityCurveChart({ data }: { data: EquityPoint[] }) {
  const colors = useThemeColors()
  const formatCurrency = useCurrencyFormatter()
  const formatAxisCurrency = useCurrencySymbolFormatter()
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Corba de guanys</h3>
        <span className="text-xs text-[var(--text-muted)]">Benefici net acumulat (sense capital aportat)</span>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
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
            domain={['dataMin - 20', 'dataMax + 20']}
            tickFormatter={formatAxisCurrency}
            tick={{ fill: colors.textMuted, fontSize: 11 }}
            stroke={colors.baseline}
            width={64}
          />
          <Tooltip
            cursor={{ stroke: colors.baseline, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const point = payload[0].payload as EquityPoint
              return (
                <ChartTooltip
                  title={formatDateTime(label as string)}
                  rows={[
                    {
                      label: 'Guany',
                      value: formatCurrency(point.profit, { signed: true }),
                      color: colors.seriesBlue,
                    },
                  ]}
                />
              )
            }}
          />
          <Area
            isAnimationActive={false}
            type="monotone"
            dataKey="profit"
            stroke={colors.seriesBlue}
            strokeWidth={2}
            fill="url(#equityFill)"
            dot={false}
            activeDot={{ r: 4, fill: colors.seriesBlue, stroke: colors.surfaceCard, strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
