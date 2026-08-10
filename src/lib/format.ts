export const DASHBOARD_TIME_ZONE = 'Europe/Madrid'

// Constructing an Intl.DateTimeFormat is expensive (~0.1ms each). These
// used to be built fresh inside every call — harmless at first, but
// dashboardDateKey runs once per floating-history point per refresh, and
// with 12k+ points across several call sites that ballooned to hundreds of
// thousands of constructions per refresh: tens of seconds of main-thread
// block, i.e. Chrome's "page unresponsive" dialog. Singletons + a result
// cache make the whole thing milliseconds.
const dateTimeFormatter = new Intl.DateTimeFormat('ca-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: DASHBOARD_TIME_ZONE,
})

const dateFormatter = new Intl.DateTimeFormat('ca-ES', {
  day: '2-digit',
  month: 'short',
  timeZone: DASHBOARD_TIME_ZONE,
})

const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: DASHBOARD_TIME_ZONE,
})

// The same 12k+ history timestamps get re-keyed on every 30s poll — cache
// the answer per ISO string. Bounded so a very long-lived tab can't grow
// it forever (at one new timestamp per minute, 200k entries is years).
const dateKeyCache = new Map<string, string>()
const DATE_KEY_CACHE_MAX = 200_000

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`
}

export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso))
}

export function formatDate(iso: string): string {
  return dateFormatter.format(new Date(iso))
}

export function dashboardDateKey(iso: string): string {
  const cached = dateKeyCache.get(iso)
  if (cached !== undefined) return cached

  const parts = dateKeyFormatter.formatToParts(new Date(iso))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const key = `${values.year}-${values.month}-${values.day}`

  if (dateKeyCache.size >= DATE_KEY_CACHE_MAX) dateKeyCache.clear()
  dateKeyCache.set(iso, key)
  return key
}

// dateKey is a plain "YYYY-MM-DD" dashboard date (already resolved to
// Europe/Madrid, see dashboardDateKey) — parse it as UTC noon so the day-of
// -week check can't be shifted by the runtime's own local timezone.
export function isWeekend(dateKey: string): boolean {
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}
