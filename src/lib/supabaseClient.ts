import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(url && anonKey)

// While VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are unset (see .env.example)
// the dashboard runs entirely on mock data from lib/mockData.ts.
export const supabase = isSupabaseConfigured ? createClient(url, anonKey) : null
