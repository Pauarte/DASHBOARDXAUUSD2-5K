export const MADRID_TIMEZONE = 'Europe/Madrid'

function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]))
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return (asUtc - date.getTime()) / 60000
}

// UTC instant of 00:00:00 Europe/Madrid on the given "YYYY-MM-DD" date.
export function madridMidnightUtc(dateStr) {
  const naiveUtc = new Date(`${dateStr}T00:00:00Z`)
  const offsetMin = tzOffsetMinutes(naiveUtc, MADRID_TIMEZONE)
  return new Date(naiveUtc.getTime() - offsetMin * 60000)
}

export function madridDateKey(value) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: MADRID_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

export function isValidDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

export function addDays(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
