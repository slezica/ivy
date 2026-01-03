import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import PlayerScreen from './src/screens/PlayerScreen'
import ClipsListScreen from './src/screens/ClipsListScreen'

type Screen = 'player' | 'clips'

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('player')

  return (
    <>
      {currentScreen === 'player' ? (
        <PlayerScreen onNavigateToClips={() => setCurrentScreen('clips')} />
      ) : (
        <ClipsListScreen onNavigateBack={() => setCurrentScreen('player')} />
      )}
      <StatusBar style="auto" />
    </>
  )
}
