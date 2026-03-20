import { Stack } from 'expo-router'
import LibraryLoadingDialog from '../src/components/LibraryLoadingDialog'
import ErrorBoundary from '../src/components/shared/ErrorBoundary'

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <Stack screenOptions={{ headerShown: false }} />
      <LibraryLoadingDialog />
    </ErrorBoundary>
  )
}
