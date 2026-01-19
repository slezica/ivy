import { Stack } from 'expo-router'
import LoadingModal from '../src/components/LoadingModal'

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <LoadingModal />
    </>
  )
}
