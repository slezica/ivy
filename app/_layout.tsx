import { Stack } from 'expo-router'
import LoadingModal from '../src/components/LoadingModal'
import ErrorBoundary from '../src/components/shared/ErrorBoundary'

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <Stack screenOptions={{ headerShown: false }} />
      <LoadingModal />
    </ErrorBoundary>
  )
}
