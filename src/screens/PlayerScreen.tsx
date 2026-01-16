import { useState, useEffect, useCallback } from 'react'
import { View, Text, StyleSheet, Alert } from 'react-native'
import { useFocusEffect } from 'expo-router'

import { Color } from '../theme'
import { useStore } from '../store'
import { Timeline } from '../components/timeline'
import IconButton from '../components/shared/IconButton'
import ScreenArea from '../components/shared/ScreenArea'
import EmptyState from '../components/shared/EmptyState'
import { MAIN_PLAYER_OWNER_ID } from '../utils'
import type { AudioFile } from '../services'

export default function PlayerScreen() {
  const { audio, addClip, play, pause, seek, syncPlaybackState } = useStore()

  // Local state - what the main player "remembers"
  const [ownFile, setOwnFile] = useState<AudioFile | null>(null)
  const [ownPosition, setOwnPosition] = useState(0)

  // Ownership check
  const isOwner = audio.ownerId === MAIN_PLAYER_OWNER_ID
  const isFileLoaded = audio.file?.uri === ownFile?.uri

  // Adopt file when audio targets the main player
  useEffect(() => {
    if (isOwner && audio.file && audio.file.uri !== ownFile?.uri) {
      setOwnFile(audio.file)
      setOwnPosition(audio.position)
    }
  }, [isOwner, audio.file, audio.position, ownFile?.uri])

  // Sync position from audio when we own playback
  useEffect(() => {
    if (isOwner && isFileLoaded) {
      setOwnPosition(audio.position)
    }
  }, [isOwner, isFileLoaded, audio.position])

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
    if (!ownFile?.uri) return

    try {
      if (isOwner && audio.status === 'playing') {
        await pause()
      } else {
        // Claim ownership and play from our remembered position
        await play({
          fileUri: ownFile.uri,
          position: ownPosition,
          ownerId: MAIN_PLAYER_OWNER_ID,
        })
      }
    } catch (error) {
      console.error('Error toggling playback:', error)
      Alert.alert('Error', 'Failed to toggle playback')
    }
  }

  const handleSeek = useCallback((position: number) => {
    // Always update local position
    setOwnPosition(position)

    // Only affect audio if we're the owner and file is loaded
    if (isOwner && isFileLoaded && ownFile?.uri) {
      seek({ fileUri: ownFile.uri, position })
    }
  }, [isOwner, isFileLoaded, ownFile, seek])

  // Show play button unless we're owner AND playing
  const isPlaying = isOwner && audio.status === 'playing'

  return (
    <ScreenArea>
      <View style={styles.content}>
        {ownFile
          ? <Player
              file={ownFile}
              position={ownPosition}
              isPlaying={isPlaying}
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

interface PlayerProps {
  file: AudioFile
  position: number
  isPlaying: boolean
  onPlayPause: () => void
  onAddClip: () => void
  onSeek: (position: number) => void
}

function Player({ file, position, isPlaying, onPlayPause, onAddClip, onSeek }: PlayerProps) {
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
        duration={file.duration}
        position={position}
        onSeek={onSeek}
        leftColor={Color.GRAY}
        rightColor={Color.PRIMARY}
      />

      <View style={styles.playbackControls}>
        <IconButton
          size={72}
          iconName={isPlaying ? 'pause' : 'play'}
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
