import { formatDateTime } from '../lib/format'

interface ConnectionStatusProps {
  loading: boolean
  isLive: boolean
  isStale: boolean
  syncAgeSeconds: number | null
  lastSyncAt: string | null
  lastCheckedAt: string | null
  connectionError: string | null
  alertsEnabled: boolean
  permission: NotificationPermission | 'unsupported'
  onEnableAlerts: () => void
  onDisableAlerts: () => void
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'sense dades'
  if (seconds < 5) return 'ara mateix'
  if (seconds < 60) return `fa ${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `fa ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `fa ${hours} h ${minutes % 60} min`
}

export function ConnectionStatus({
  loading,
  isLive,
  isStale,
  syncAgeSeconds,
  lastSyncAt,
  lastCheckedAt,
  connectionError,
  alertsEnabled,
  permission,
  onEnableAlerts,
  onDisableAlerts,
}: ConnectionStatusProps) {
  const state = loading
    ? { label: 'Comprovant connexió', tone: 'neutral' }
    : connectionError
      ? { label: 'Error de connexió', tone: 'critical' }
      : !isLive
        ? { label: 'Esperant dades reals', tone: 'warning' }
        : isStale
          ? { label: 'Sincronització aturada', tone: 'warning' }
          : { label: 'Connectat', tone: 'good' }

  const alertLabel =
    permission === 'unsupported'
      ? 'Alertes no disponibles'
      : permission === 'denied'
        ? 'Alertes bloquejades'
        : alertsEnabled
          ? 'Alertes actives'
          : 'Activar alertes'

  return (
    <section className={`connection-card connection-card--${state.tone}`} aria-live="polite">
      <div className="connection-card__main">
        <div className="connection-card__status">
          <span className="connection-card__dot" aria-hidden="true" />
          <strong>{state.label}</strong>
        </div>
        <div className="connection-card__details">
          <span>
            Última sincronització:{' '}
            <strong>{lastSyncAt ? formatDateTime(lastSyncAt) : 'encara no disponible'}</strong>
          </span>
          <span>{formatAge(syncAgeSeconds)}</span>
          {connectionError && lastCheckedAt && (
            <span>Últim intent: {formatDateTime(lastCheckedAt)}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        className="connection-card__alerts"
        disabled={permission === 'unsupported' || permission === 'denied'}
        onClick={alertsEnabled ? onDisableAlerts : onEnableAlerts}
      >
        {alertLabel}
      </button>
    </section>
  )
}
