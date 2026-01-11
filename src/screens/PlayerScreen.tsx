/**
 * PlayerScreen
 *
 * Main playback screen with timeline control.
 */

import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Alert,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useStore } from '../store'
import TimelineBar from '../components/TimelineBar'
import { Color } from '../theme'

export default function PlayerScreen() {
  const { file, pickAndLoadFile, addClip, playback, play, pause } = useStore()

  const handleLoadFile = async () => {
    try {
      await pickAndLoadFile()
    } catch (error) {
      console.error(error)
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

  const handleAddClip = async () => {
    try {
      await addClip('')
      Alert.alert('Clip Added', 'Clip saved at current position')
    } catch (error) {
      console.error('Error adding clip:', error)
      Alert.alert('Error', 'Failed to add clip')
    }
  }

  const handlePlayPause = async () => {
    try {
      if (playback.isPlaying) {
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
        <View style={styles.header}>
          <Text style={styles.title}>Audio Player</Text>
        </View>

        {file ? (
          <View style={styles.playerContainer}>
            <View style={styles.fileInfo}>
              <Text style={styles.fileName}>{file.name}</Text>
            </View>

            <TimelineBar />

            {/* Play/Pause Button */}
            <View style={styles.playbackControls}>
              <TouchableOpacity
                style={styles.playPauseButton}
                onPress={handlePlayPause}
              >
                <Ionicons
                  name={playback.isPlaying ? 'pause' : 'play'}
                  size={32}
                  color={Color.WHITE}
                />
              </TouchableOpacity>
            </View>

            {/* Floating Action Button */}
            <TouchableOpacity
              style={styles.fab}
              onPress={handleAddClip}
            >
              <Text style={styles.fabIcon}>+</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No audio file loaded</Text>
            <TouchableOpacity
              style={[styles.button, styles.loadButton]}
              onPress={handleLoadFile}
            >
              <Text style={[styles.buttonText, styles.loadButtonText]}>
                Load Audio File
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </SafeAreaView>
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
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Color.GRAY_LIGHT,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  playerContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 40,
    position: 'relative',
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
  },
  playbackControls: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  playPauseButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Color.PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Color.BLACK,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 4,
  },
  fab: {
    position: 'absolute',
    bottom: 30,
    right: 30,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Color.PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Color.BLACK,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  fabIcon: {
    fontSize: 32,
    fontWeight: '300',
    color: Color.WHITE,
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
