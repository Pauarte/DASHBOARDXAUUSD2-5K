import { useState, type ReactNode } from 'react'
import {
  checkPassword,
  clearIdentity,
  loadStoredIdentity,
  storeIdentity,
  type PartnerIdentity,
} from '../lib/partnersAuth'

export function PasswordGate({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: (identity: PartnerIdentity, logout: () => void) => ReactNode
}) {
  const [identity, setIdentity] = useState<PartnerIdentity | null>(() => loadStoredIdentity())
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState(false)

  if (!identity) {
    return (
      <div className="min-h-screen bg-[var(--surface-2)] flex items-center justify-center px-6">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const found = checkPassword(password)
            if (found) {
              storeIdentity(found)
              setIdentity(found)
              setAuthError(false)
            } else {
              setAuthError(true)
            }
          }}
          className="w-full max-w-xs rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-6 flex flex-col gap-3"
        >
          <h1 className="text-base font-semibold text-[var(--text-primary)]">{title}</h1>
          {subtitle && <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>}
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setAuthError(false)
            }}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"
          />
          {authError && <p className="text-xs text-[var(--critical)]">Contrasenya incorrecta.</p>}
          <button
            type="submit"
            className="rounded-lg bg-[var(--series-blue)] px-4 py-2 text-sm font-semibold text-white"
          >
            Entrar
          </button>
        </form>
      </div>
    )
  }

  return (
    <>
      {children(identity, () => {
        clearIdentity()
        setIdentity(null)
      })}
    </>
  )
}
