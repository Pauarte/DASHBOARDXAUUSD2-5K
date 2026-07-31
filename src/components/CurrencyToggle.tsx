import { useCurrency } from '../lib/currency'

export function CurrencyToggle() {
  const { currency, setCurrency } = useCurrency()

  return (
    <div className="flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-card)] p-0.5 text-xs font-medium">
      {(['USD', 'EUR'] as const).map((option) => (
        <button
          key={option}
          onClick={() => setCurrency(option)}
          className={`rounded-full px-2.5 py-1 transition-colors ${
            currency === option
              ? 'bg-[var(--series-blue)] text-white'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          {option === 'USD' ? '$' : '€'}
        </button>
      ))}
    </div>
  )
}
