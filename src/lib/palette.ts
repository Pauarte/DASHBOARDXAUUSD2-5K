export const palette = {
  light: {
    textMuted: '#898781',
    baseline: '#c3c2b7',
    surfaceCard: '#ffffff',
    seriesBlue: '#2a78d6',
    good: '#0ca30c',
    critical: '#d03b3b',
  },
  dark: {
    textMuted: '#898781',
    baseline: '#383835',
    surfaceCard: '#212120',
    seriesBlue: '#3987e5',
    good: '#0ca30c',
    critical: '#e66767',
  },
} as const

export type Palette = typeof palette.light

function readIsDark(): boolean {
  if (typeof document === 'undefined') return false
  const themeAttr = document.documentElement.getAttribute('data-theme')
  if (themeAttr === 'dark') return true
  if (themeAttr === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function subscribeTheme(callback: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', callback)
  const observer = new MutationObserver(callback)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => {
    media.removeEventListener('change', callback)
    observer.disconnect()
  }
}

export { readIsDark }
