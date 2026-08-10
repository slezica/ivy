import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { Freeze } from 'react-freeze'
import { useStore } from '../src/store'
import LibraryLoadingDialog from '../src/components/LibraryLoadingDialog'
import ErrorBoundary from '../src/components/shared/ErrorBoundary'

SplashScreen.preventAutoHideAsync()

// Freeze the UI tree while the app is backgrounded: playback keeps the JS
// runtime alive, so 1 Hz progress updates would otherwise re-render every
// mounted component with the screen off (measured at ~30% of a core).
// Store state keeps updating underneath; one catch-up render happens on wake.
function useAppBackgrounded() {
  const [backgrounded, setBackgrounded] = useState(false)

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setBackgrounded(state !== 'active')
    })
    return () => subscription.remove()
  }, [])

  return backgrounded
}

export default function RootLayout() {
  const initialized = useStore(s => s.initialized)
  const initializeApplication = useStore(s => s.initializeApplication)
  const backgrounded = useAppBackgrounded()

  useEffect(() => {
    initializeApplication().catch((error) => {
      console.error('[App] Initialization failed:', error)
    })
  }, [])

  useEffect(() => {
    if (initialized) SplashScreen.hideAsync()
  }, [initialized])

  if (!initialized) return null

  return (
    <ErrorBoundary>
      <Freeze freeze={backgrounded}>
        <Stack screenOptions={{ headerShown: false }} />
        <LibraryLoadingDialog />
      </Freeze>
    </ErrorBoundary>
  )
}
