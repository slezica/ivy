import { useCallback } from 'react'
import { View, Text, StyleSheet, Alert } from 'react-native'
import { useFocusEffect } from 'expo-router'

import { Color } from '../theme'
import { useStore } from '../store'
import { Timeline } from '../components/timeline'
import IconButton from '../components/shared/IconButton'
import ScreenArea from '../components/shared/ScreenArea'
import EmptyState from '../components/shared/EmptyState'

const PLAYER_OWNER_ID = 'player-screen'

export default function PlayerScreen() {
  const { player, addClip, play, pause, seek, syncPlaybackState } = useStore()

  // Sync position immediately when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      syncPlaybackState()
    }, [syncPlaybackState])
  )

  const handleAddClip = async () => {
    try {
      await addClip('')
    } catch (error) {
      console.error('Error adding clip:', error)
      Alert.alert('Error', 'Failed to add clip')
    }
  }

  const handlePlayPause = async () => {
    try {
      if (player.status === 'playing') {
        await pause()
      } else if (player.file) {
        // Claim ownership when playing from main player
        await play({
          fileUri: player.file.uri,
          position: player.position,
          ownerId: PLAYER_OWNER_ID,
        })
      }
    } catch (error) {
      console.error('Error toggling playback:', error)
      Alert.alert('Error', 'Failed to toggle playback')
    }
  }

  const handleSeek = useCallback((position: number) => {
    if (player.file?.uri) {
      seek({ fileUri: player.file.uri, position })
    }
  }, [player.file?.uri, seek])

  return (
    <ScreenArea>
      <View style={styles.content}>
        {player.file
          ? <Player
              file={player.file}
              player={player}
              onPlayPause={handlePlayPause}
              onAddClip={handleAddClip}
              onSeek={handleSeek}
            />
          : <EmptyState title="Not playing" subtitle="Select a file from your library" />
        }
      </View>
    </ScreenArea>
  )
}

function Player({ file, player, onPlayPause, onAddClip, onSeek }: any) {
  return (
    <View style={styles.playerContainer}>
      <View style={styles.spacerTop} />

      <View style={styles.fileInfo}>
        <Text style={styles.title} numberOfLines={2}>
          {file.title || file.name}
        </Text>
        {file.artist && (
          <Text style={styles.artist} numberOfLines={1}>
            {file.artist}
          </Text>
        )}
      </View>

      <Timeline
        duration={player.duration}
        position={player.position}
        onSeek={onSeek}
        leftColor={Color.GRAY}
        rightColor={Color.PRIMARY}
      />

      <View style={styles.playbackControls}>
        <IconButton
          size={72}
          iconName={player.status === 'playing' ? 'pause' : 'play'}
          onPress={onPlayPause}
          testID="play-pause-button"
        />

        <IconButton
          iconName="bookmark"
          onPress={onAddClip}
          testID="add-clip-button"
          size={48}
        />
      </View>

    <View style={styles.spacerBottom} />
  </View>
  )
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  playerContainer: {
    flex: 1,
    gap: 24,
  },
  spacerTop: {
    flex: 8,
  },
  spacerBottom: {
    flex: 2,
  },
  fileInfo: {
    paddingHorizontal: 32,
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    color: Color.BLACK,
    lineHeight: 28,
  },
  artist: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    color: Color.GRAY_DARK,
  },
  playbackControls: {
    alignItems: 'center',
    gap: 24,
  },
})
