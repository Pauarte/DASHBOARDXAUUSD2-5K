import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(url && anonKey)

// While VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are unset (see .env.example)
// the dashboard runs entirely on mock data from lib/mockData.ts.
export const supabase = isSupabaseConfigured ? createClient(url, anonKey) : null

// Supabase/PostgREST silently caps any single request at its configured
// max-rows (1000 here), no matter what .limit() asks for — a plain
// .limit(5000) on a growing table quietly returns only the first 1000 rows
// (chronologically oldest, if ordered ascending), which broke recent-data
// calculations as floating_pnl_snapshots grew past 1000 rows. Page through
// with .range() until a page comes back short.
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
  maxRows = 100000,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await page(offset, offset + pageSize - 1)
    if (error) throw error
    if (!data) break
    rows.push(...data)
    if (data.length < pageSize) break
  }
  return rows
}
