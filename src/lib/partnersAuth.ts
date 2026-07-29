export interface PartnerIdentity {
  personName: string
  isAdmin: boolean
}

// Casual barrier only — this is a static frontend with no backend/auth, so
// this map ships in the JS bundle and isn't secret from anyone who reads
// the source. It just keeps a random visitor with the dashboard link from
// immediately seeing partner names/amounts; it is not real access control.
const PASSWORDS: Record<string, PartnerIdentity> = {
  'XAUUSD67!': { personName: 'Arte', isAdmin: true },
  '2009oca5.': { personName: 'Uri', isAdmin: true },
  '1307Marti': { personName: 'Busi', isAdmin: false },
}

const STORAGE_KEY = 'socis-identity'

export function checkPassword(password: string): PartnerIdentity | null {
  return PASSWORDS[password] ?? null
}

export function loadStoredIdentity(): PartnerIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PartnerIdentity) : null
  } catch {
    return null
  }
}

export function storeIdentity(identity: PartnerIdentity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
}

export function clearIdentity(): void {
  localStorage.removeItem(STORAGE_KEY)
}
