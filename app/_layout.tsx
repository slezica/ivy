import { useEffect } from 'react'
import { Stack } from 'expo-router'
import LoadingModal from '../src/components/LoadingModal'
import { transcriptionService } from '../src/services/TranscriptionService'

export default function RootLayout() {
  useEffect(() => {
    // Start transcription service on app launch
    transcriptionService.start()
  }, [])

  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <LoadingModal />
    </>
  )
}
