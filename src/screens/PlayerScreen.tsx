import { View, Text, StyleSheet, Alert } from 'react-native'

import { Color } from '../theme'
import { useStore } from '../store'
import TimelineBar from '../components/TimelineBar'
import IconButton from '../components/shared/IconButton'
import ScreenArea from '../components/shared/ScreenArea'
import EmptyState from '../components/shared/EmptyState'


export default function PlayerScreen() {
  const { player, addClip, play, pause } = useStore()

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
      } else {
        await play()
      }
    } catch (error) {
      console.error('Error toggling playback:', error)
      Alert.alert('Error', 'Failed to toggle playback')
    }
  }

  return (
    <ScreenArea>
      <View style={styles.content}>
        {player.file
          ? <Player
              file={player.file}
              player={player}
              onPlayPause={handlePlayPause}
              onAddClip={handleAddClip}
            />
          : <EmptyState title="Not playing" subtitle="Select a file from your library" />
        }
      </View>
    </ScreenArea>
  )
}

function Player({ file, player, onPlayPause, onAddClip }: any) {
  return (
    <View style={styles.playerContainer}>
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

      <TimelineBar />

    <View style={styles.playbackControls}>
      <IconButton
        size={72}
        iconName={player.status === 'playing' ? 'pause' : 'play'}
        onPress={onPlayPause}
      />

      <IconButton
        iconName="bookmark"
        onPress={onAddClip}
        size={48}
      />
    </View>
  </View>
  )
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  playerContainer: {
    flex: 1,
    justifyContent: 'center',
    gap: 24,
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
