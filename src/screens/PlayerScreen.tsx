/**
 * PlayerScreen
 *
 * Main playback screen with controls and progress bar.
 */

import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Alert,
} from 'react-native'
import { Link } from 'expo-router'
import { useStore } from '../store'
import PlaybackControls from '../components/PlaybackControls'
import ProgressBar from '../components/ProgressBar'

export default function PlayerScreen() {
  const { file, pickAndLoadFile, addClip } = useStore()

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

            <ProgressBar />
            <PlaybackControls />

            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.button, styles.addButton]}
                onPress={handleAddClip}
              >
                <Text style={[styles.buttonText, styles.addButtonText]}>
                  + Add Clip
                </Text>
              </TouchableOpacity>

              <Link href="/clips" asChild>
                <TouchableOpacity style={styles.button}>
                  <Text style={styles.buttonText}>View Clips</Text>
                </TouchableOpacity>
              </Link>
            </View>
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
    backgroundColor: '#fff',
  },
  content: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  playerContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingBottom: 40,
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
  actions: {
    paddingHorizontal: 20,
    paddingTop: 20,
    gap: 12,
  },
  button: {
    backgroundColor: '#f0f0f0',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  addButton: {
    backgroundColor: '#007AFF',
  },
  addButtonText: {
    color: '#fff',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
  },
  loadButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 30,
  },
  loadButtonText: {
    color: '#fff',
  },
})
