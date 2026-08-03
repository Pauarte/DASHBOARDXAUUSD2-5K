import { useCurrency } from '../lib/currency'

export function CurrencyToggle() {
  const { currency, setCurrency } = useCurrency()

  return (
    <div className="inline-flex rounded-full border border-[var(--border)] p-0.5 text-xs font-medium">
      {(['USD', 'EUR'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setCurrency(option)}
          className={`rounded-full px-2.5 py-1 transition-colors ${
            currency === option
              ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          }`}
        >
          {option === 'USD' ? '$' : '€'}
        </button>
      ))}
    </div>
  )
}
