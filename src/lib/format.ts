export const DASHBOARD_TIME_ZONE = 'Europe/Madrid'

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ca-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DASHBOARD_TIME_ZONE,
  })
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ca-ES', {
    day: '2-digit',
    month: 'short',
    timeZone: DASHBOARD_TIME_ZONE,
  })
}

export function dashboardDateKey(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: DASHBOARD_TIME_ZONE,
  }).formatToParts(new Date(iso))

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

// dateKey is a plain "YYYY-MM-DD" dashboard date (already resolved to
// Europe/Madrid, see dashboardDateKey) — parse it as UTC noon so the day-of
// -week check can't be shifted by the runtime's own local timezone.
export function isWeekend(dateKey: string): boolean {
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}
