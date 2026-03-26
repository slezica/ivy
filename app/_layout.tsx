import { useEffect } from 'react'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useStore } from '../src/store'
import LibraryLoadingDialog from '../src/components/LibraryLoadingDialog'
import ErrorBoundary from '../src/components/shared/ErrorBoundary'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const initialized = useStore(s => s.initialized)
  const initializeApplication = useStore(s => s.initializeApplication)

  useEffect(() => {
    initializeApplication()
  }, [])

  useEffect(() => {
    if (initialized) SplashScreen.hideAsync()
  }, [initialized])

  if (!initialized) return null

  return (
    <ErrorBoundary>
      <Stack screenOptions={{ headerShown: false }} />
      <LibraryLoadingDialog />
    </ErrorBoundary>
  )
}
