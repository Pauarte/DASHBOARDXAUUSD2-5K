import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { EquityPoint } from '../lib/stats'
import { formatDateTime, formatPercent } from '../lib/format'
import { ChartTooltip } from './ChartTooltip'
import { useThemeColors } from '../lib/useThemeColors'

export function DrawdownChart({ data }: { data: EquityPoint[] }) {
  const colors = useThemeColors()
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Drawdown</h3>
        <span className="text-xs text-[var(--text-muted)]">% from equity peak</span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.critical} stopOpacity={0} />
              <stop offset="100%" stopColor={colors.critical} stopOpacity={0.22} />
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
            domain={['dataMin - 1', 0]}
            tickFormatter={(v) => `${Math.round(v)}%`}
            tick={{ fill: colors.textMuted, fontSize: 11 }}
            stroke={colors.baseline}
            width={48}
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
                    { label: 'Drawdown', value: formatPercent(point.drawdownPct), color: colors.critical },
                  ]}
                />
              )
            }}
          />
          <Area
            isAnimationActive={false}
            type="monotone"
            dataKey="drawdownPct"
            stroke={colors.critical}
            strokeWidth={2}
            fill="url(#ddFill)"
            dot={false}
            activeDot={{ r: 4, fill: colors.critical, stroke: colors.surfaceCard, strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
