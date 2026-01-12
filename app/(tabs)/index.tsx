/**
 * LibraryScreen
 *
 * Shows a list of previously opened audio files for quick access.
 */

import { View, Text, StyleSheet, SafeAreaView, Alert, FlatList, TouchableOpacity } from 'react-native'
import { useState, useCallback } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useStore } from '../../src/store'
import IconButton from '../../src/components/shared/IconButton'
import { Color } from '../../src/theme'
import type { AudioFile } from '../../src/services/DatabaseService'

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`

  return date.toLocaleDateString()
}

export default function LibraryScreen() {
  const router = useRouter()
  const { loadFileWithPicker, getAllFiles, loadFileWithUri } = useStore()
  const [files, setFiles] = useState<AudioFile[]>([])

  // Refresh file list when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      setFiles(getAllFiles())
    }, [getAllFiles])
  )

  const handleLoadFile = async () => {
    try {
      await loadFileWithPicker()
      // Refresh list and navigate to player
      setFiles(getAllFiles())
      router.push('/player')
    } catch (error) {
      console.error(error)
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

  const handleFilePress = async (file: AudioFile) => {
    try {
      await loadFileWithUri(file.uri, file.name)
      router.push('/player')
    } catch (error) {
      console.error('Error loading file:', error)
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Library</Text>
      </View>

      {files.length > 0 ? (
        <FlatList
          data={files}
          keyExtractor={(item) => item.uri}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.fileItem}
              onPress={() => handleFilePress(item)}
              activeOpacity={0.7}
            >
              <View style={styles.fileInfo}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {item.name}
                </Text>
                <View style={styles.fileMetadata}>
                  {item.duration > 0 && (
                    <Text style={styles.fileDuration}>
                      {formatTime(item.duration)}
                    </Text>
                  )}
                  {item.position > 0 && (
                    <Text style={styles.fileProgress}>
                      • {Math.round((item.position / item.duration) * 100)}% played
                    </Text>
                  )}
                </View>
                <Text style={styles.fileDate}>
                  {formatDate(item.opened_at)}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        />
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>No files yet</Text>
          <Text style={styles.emptySubtext}>
            Open an audio file to add it to your library
          </Text>
        </View>
      )}

      {/* FAB */}
      <View style={styles.fabContainer} pointerEvents="box-none">
        <IconButton
          iconName="add"
          onPress={handleLoadFile}
          size={56}
          style={styles.fab}
        />
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Color.WHITE,
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
    color: Color.BLACK,
  },
  listContent: {
    padding: 16,
    paddingBottom: 80, // Space for FAB
  },
  fileItem: {
    backgroundColor: Color.GRAY_LIGHTER,
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  },
  fileInfo: {
    gap: 4,
  },
  fileName: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.BLACK,
  },
  fileMetadata: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  fileDuration: {
    fontSize: 14,
    color: Color.GRAY_DARK,
  },
  fileProgress: {
    fontSize: 14,
    color: Color.PRIMARY,
  },
  fileDate: {
    fontSize: 12,
    color: Color.GRAY_MEDIUM,
    marginTop: 2,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: Color.GRAY_DARK,
  },
  emptySubtext: {
    fontSize: 14,
    color: Color.GRAY_MEDIUM,
  },
  fabContainer: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    top: 0,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    padding: 20,
  },
  fab: {
    // Position is handled by fabContainer
  },
})
