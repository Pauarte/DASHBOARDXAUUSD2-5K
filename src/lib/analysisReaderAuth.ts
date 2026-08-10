// Bearer-token holder for the read-only "analysis_reader" profile. This is
// deliberately NOT like partnersAuth.ts's hardcoded password map: the token
// is a real, revocable, per-holder secret minted server-side (see
// supabase/analysis_reader.sql) and typed in once by the operator. It's
// kept in sessionStorage (cleared when the tab closes), never localStorage,
// since this credential is more sensitive than the shared partner
// passwords and doesn't need to persist across visits.
const STORAGE_KEY = 'analysis-reader-token'

export function loadStoredAnalysisToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeAnalysisToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token)
}

export function clearAnalysisToken(): void {
  sessionStorage.removeItem(STORAGE_KEY)
}
