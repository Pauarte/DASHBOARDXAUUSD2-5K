import pg from 'pg'
const { Pool, types } = pg

// node-postgres auto-converts timestamp/timestamptz/date columns into JS
// Date objects by default, using the *local* timezone of whatever machine
// runs this function - fine most of the time, but everything else in this
// codebase (groupIntoBaskets, the Europe/Madrid date-key helpers) expects
// plain ISO-ish strings straight from Postgres, and compares/sorts them as
// such. Force identity parsing so a value stays exactly what Postgres sent.
types.setTypeParser(1114, (value) => value) // timestamp
types.setTypeParser(1184, (value) => value) // timestamptz
types.setTypeParser(1082, (value) => value) // date

// One pool per role, created lazily and reused across warm invocations of
// the same serverless instance (Vercel keeps the module scope alive between
// calls on a warm lambda). `max: 3` keeps this well under Supabase's
// pooler connection cap even if several instances are warm at once - use
// Supabase's *transaction pooler* connection string (port 6543), not the
// direct 5432 connection, so short-lived serverless connections don't
// exhaust the database's own connection limit.
let readerPool = null
let writerPool = null

function makePool(connectionString, label) {
  if (!connectionString) return null
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: true },
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: label,
    // Force UTC output for timestamp columns regardless of the DB server's
    // own default session timezone, so the identity-parsed strings above
    // are always unambiguous and Date.parse()-safe.
    options: '-c timezone=UTC',
  })
}

// ANALYSIS_READER_DB_URL / ANALYSIS_SNAPSHOT_WRITER_DB_URL are Vercel
// server-side env vars (never prefixed VITE_, so Vite never inlines them
// into the browser bundle) holding a full postgres:// connection string
// authenticated as analysis_reader / analysis_snapshot_writer respectively
// - see supabase/analysis_reader.sql. Neither role can do anything beyond
// what that migration grants, regardless of what this code does wrong.
export function getReaderPool() {
  if (readerPool === null) readerPool = makePool(process.env.ANALYSIS_READER_DB_URL, 'analysis-reader-api')
  return readerPool
}

export function getWriterPool() {
  if (writerPool === null) {
    writerPool = makePool(process.env.ANALYSIS_SNAPSHOT_WRITER_DB_URL, 'analysis-snapshot-writer')
  }
  return writerPool
}

// Verifies the bearer token via verify_and_log_analysis_token() (runs as
// SECURITY DEFINER against analysis_tokens, which analysis_reader itself
// cannot read) and returns { ok, status, reason, label }. Never throws for
// an invalid/expired/revoked/rate-limited token - only for a genuine DB
// connectivity failure, which the caller should turn into a 503.
export async function verifyAnalysisToken(pool, token, route) {
  if (!token) return { ok: false, status: 401, reason: 'missing_token', label: null }
  const { rows } = await pool.query('select * from verify_and_log_analysis_token($1, $2)', [token, route])
  const row = rows[0]
  if (row?.ok) return { ok: true, status: 200, reason: 'ok', label: row.token_label }

  const statusByReason = {
    invalid_token: 401,
    revoked: 403,
    expired: 401,
    rate_limited: 429,
  }
  return { ok: false, status: statusByReason[row?.reason] ?? 401, reason: row?.reason ?? 'invalid_token', label: null }
}

export function extractBearerToken(request) {
  const header = request.headers?.authorization ?? request.headers?.Authorization
  if (!header || typeof header !== 'string') return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}
