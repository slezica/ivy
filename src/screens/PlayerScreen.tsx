import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Alert,
} from 'react-native'

import { Color } from '../theme'
import { useStore } from '../store'
import TimelineBar from '../components/TimelineBar'
import IconButton from '../components/shared/IconButton'


export default function PlayerScreen() {
  const { player, loadFileWithPicker, addClip, play, pause } = useStore()

  const handleLoadFile = async () => {
    try {
      await loadFileWithPicker()
    } catch (error) {
      console.error(error)
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

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
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {player.file
          ? <Player file={player.file} player={player} onPlayPause={handlePlayPause} onAddClip={handleAddClip} />
          : <FileLoader onLoadFile={handleLoadFile} isLoading={player.status === 'loading'} />
        }
      </View>
    </SafeAreaView>
  )
}

function Player({ file, player, onPlayPause, onAddClip }: any) {
  return (
    <View style={styles.playerContainer}>
    <View style={styles.fileInfo}>
      <Text style={styles.fileName}>{file.name}</Text>
    </View>

    <TimelineBar />

    <View style={styles.playbackControls}>
      <IconButton
        size={72}
        iconName={player.status === 'playing' ? 'pause' : 'play'}
        onPress={onPlayPause}
        disabled={player.status === 'loading'}
      />
      <IconButton
        iconName="bookmark"
        onPress={onAddClip}
        size={48}
        disabled={player.status === 'loading'}
      />
    </View>
  </View>
  )
}

function FileLoader({ onLoadFile, isLoading }: any) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>
        {isLoading ? 'Loading audio file...' : 'No audio file loaded'}
      </Text>
      <TouchableOpacity
        style={[styles.button, styles.loadButton]}
        onPress={onLoadFile}
        disabled={isLoading}
      >
        <Text style={[styles.buttonText, styles.loadButtonText]}>
          Load Audio File
        </Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Color.WHITE,
  },
  content: {
    flex: 1,
  },
  playerContainer: {
    flex: 1,
    justifyContent: 'center',
    position: 'relative',
    gap: 8,
    paddingTop: 96
  },
  fileInfo: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: 'center',
  },
  fileName: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    color: Color.BLACK,
  },
  playbackControls: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 24,
  },
  button: {
    backgroundColor: Color.GRAY_LIGHTER,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.GRAY_DARKER,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
  },
  emptyText: {
    fontSize: 16,
    color: Color.GRAY_DARK,
  },
  loadButton: {
    backgroundColor: Color.PRIMARY,
    paddingHorizontal: 30,
  },
  loadButtonText: {
    color: Color.WHITE,
  },
})
