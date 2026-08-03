import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Currency = 'USD' | 'EUR'

// All amounts in the app are stored/computed in USD (the MT5 account's own
// currency). This is a fixed conversion rate, not a live-fetched one — good
// enough for display purposes and avoids depending on an external FX API.
const USD_TO_EUR_RATE = 0.92

const STORAGE_KEY = 'dashboard-currency'

interface CurrencyContextValue {
  currency: Currency
  setCurrency: (currency: Currency) => void
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null)

function readStoredCurrency(): Currency {
  if (typeof window === 'undefined') return 'USD'
  return window.localStorage.getItem(STORAGE_KEY) === 'EUR' ? 'EUR' : 'USD'
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<Currency>(readStoredCurrency)

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, currency)
  }, [currency])

  const value = useMemo(() => ({ currency, setCurrency: setCurrencyState }), [currency])

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider')
  return ctx
}

// Raw USD -> display-currency conversion, no formatting — for compact
// contexts (small calendar cells) that just round the number themselves.
export function useCurrencyValue() {
  const { currency } = useCurrency()
  return (value: number) => (currency === 'EUR' ? value * USD_TO_EUR_RATE : value)
}

// Converts a USD amount into the user's chosen display currency and formats
// it with the right symbol/locale. Every $ value in the app is stored in USD
// internally — this is purely a display-layer conversion.
export function useCurrencyFormatter() {
  const { currency } = useCurrency()

  return (value: number, opts: { signed?: boolean } = {}) => {
    const converted = currency === 'EUR' ? value * USD_TO_EUR_RATE : value
    const sign = opts.signed && converted > 0 ? '+' : ''
    return `${sign}${converted.toLocaleString(currency === 'EUR' ? 'ca-ES' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }
}

// For chart axes / compact contexts that just want a rounded number with
// the right symbol, no full Intl.NumberFormat currency string.
export function useCurrencySymbolFormatter() {
  const { currency } = useCurrency()

  return (value: number) => {
    const converted = currency === 'EUR' ? value * USD_TO_EUR_RATE : value
    const rounded = Math.round(converted).toLocaleString(currency === 'EUR' ? 'ca-ES' : 'en-US')
    return currency === 'EUR' ? `${rounded} €` : `$${rounded}`
  }
}
