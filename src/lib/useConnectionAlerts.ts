import { useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'monitor-bots-connection-alerts'

type AlertPermission = NotificationPermission | 'unsupported'

interface ConnectionAlerts {
  alertsEnabled: boolean
  permission: AlertPermission
  requestAlerts: () => Promise<void>
  disableAlerts: () => void
}

async function showNotification(title: string, body: string) {
  const options: NotificationOptions = {
    body,
    icon: '/icon.png',
    badge: '/icon.png',
    tag: 'monitor-bots-connection',
  }

  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready
    await registration.showNotification(title, options)
    return
  }

  new Notification(title, options)
}

export function useConnectionAlerts(
  hasConnectionAlert: boolean,
  isLive: boolean,
  alertBody: string,
): ConnectionAlerts {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  const [permission, setPermission] = useState<AlertPermission>(
    supported ? Notification.permission : 'unsupported',
  )
  const [alertsEnabled, setAlertsEnabled] = useState(
    supported &&
      Notification.permission === 'granted' &&
      window.localStorage.getItem(STORAGE_KEY) === 'true',
  )
  const previousAlert = useRef<boolean | null>(null)

  useEffect(() => {
    if (!alertsEnabled || !isLive) {
      previousAlert.current = hasConnectionAlert
      return
    }

    if (hasConnectionAlert && previousAlert.current !== true) {
      void showNotification('Alerta del monitor', alertBody).catch(console.error)
    } else if (!hasConnectionAlert && previousAlert.current === true) {
      void showNotification(
        'Connexió recuperada',
        'El monitor torna a rebre dades del bot correctament.',
      ).catch(console.error)
    }

    previousAlert.current = hasConnectionAlert
  }, [alertBody, alertsEnabled, hasConnectionAlert, isLive])

  async function requestAlerts() {
    if (!supported) return
    const result = await Notification.requestPermission()
    setPermission(result)
    const enabled = result === 'granted'
    if (enabled) previousAlert.current = null
    setAlertsEnabled(enabled)
    window.localStorage.setItem(STORAGE_KEY, String(enabled))
  }

  function disableAlerts() {
    setAlertsEnabled(false)
    window.localStorage.setItem(STORAGE_KEY, 'false')
  }

  return {
    alertsEnabled,
    permission,
    requestAlerts,
    disableAlerts,
  }
}
