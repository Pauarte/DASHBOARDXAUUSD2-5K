import { useEffect, useState } from 'react'
import { palette, readIsDark, subscribeTheme } from './palette'

export function useThemeColors() {
  const [isDark, setIsDark] = useState(readIsDark)

  useEffect(() => subscribeTheme(() => setIsDark(readIsDark())), [])

  return isDark ? palette.dark : palette.light
}
