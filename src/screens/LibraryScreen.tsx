/**
 * LibraryScreen
 *
 * Shows a list of previously opened audio files for quick access.
 */

import { View, Text, StyleSheet, Alert, FlatList, TouchableOpacity, Image } from 'react-native'
import { useCallback } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useStore } from '../store'
import IconButton from '../components/shared/IconButton'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import EmptyState from '../components/shared/EmptyState'
import { Color } from '../theme'
import type { AudioFile } from '../services/DatabaseService'

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
  const { loadFileWithPicker, fetchFiles, loadFileWithUri, files, __DEV_resetApp } = useStore()

  // Refresh file list when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      fetchFiles()
    }, [fetchFiles])
  )

  const handleLoadFile = async () => {
    try {
      await loadFileWithPicker()
      // Refresh list
      fetchFiles()
      // Navigate to player tab
      router.push('/player')
    } catch (error) {
      console.error(error)
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

  const handleFilePress = async (file: AudioFile) => {
    try {
      await loadFileWithUri(file.uri, file.name)
      // Navigate to player tab
      router.push('/player')
    } catch (error) {
      console.error('Error loading file:', error)
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

  const handleDevReset = () => {
    Alert.alert(
      'Reset App',
      'This will clear all files, clips, and playback data. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await __DEV_resetApp()
              Alert.alert('Success', 'App reset complete!')
            } catch (error) {
              console.error('Error resetting app:', error)
              Alert.alert('Error', 'Failed to reset app')
            }
          },
        },
      ]
    )
  }

  const filesArray = Object.values(files)

  return (
    <ScreenArea>
      <Header title="Library">
        <TouchableOpacity
          style={styles.devResetButton}
          onPress={handleDevReset}
        >
          <Text style={styles.devResetButtonText}>🔧 Reset</Text>
        </TouchableOpacity>
      </Header>

      {filesArray.length > 0 ? (
        <FlatList
          data={filesArray}
          keyExtractor={(item) => item.uri}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.fileItem}
              onPress={() => handleFilePress(item)}
              activeOpacity={0.7}
            >
              {/* Artwork */}
              {item.artwork ? (
                <Image
                  source={{ uri: item.artwork }}
                  style={styles.artwork}
                  resizeMode="cover"
                />
              ) : (
                <View style={styles.artworkPlaceholder}>
                  <Text style={styles.artworkPlaceholderIcon}>🎵</Text>
                </View>
              )}

              {/* File Info */}
              <View style={styles.fileInfo}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {item.title || item.name}
                </Text>
                {item.artist && (
                  <Text style={styles.fileArtist} numberOfLines={1}>
                    {item.artist}
                  </Text>
                )}
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
        <EmptyState
          title="No files yet"
          subtitle="Open an audio file to add it to your library"
        />
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
    </ScreenArea>
  )
}

const styles = StyleSheet.create({
  devResetButton: {
    backgroundColor: Color.DESTRUCTIVE,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  devResetButtonText: {
    color: Color.WHITE,
    fontSize: 12,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    paddingBottom: 80, // Space for FAB
  },
  fileItem: {
    flexDirection: 'row',
    backgroundColor: Color.GRAY_LIGHTER,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    gap: 12,
  },
  artwork: {
    width: 60,
    height: 60,
    borderRadius: 6,
  },
  artworkPlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 6,
    backgroundColor: Color.GRAY_LIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  artworkPlaceholderIcon: {
    fontSize: 24,
  },
  fileInfo: {
    flex: 1,
    gap: 4,
  },
  fileName: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.BLACK,
  },
  fileArtist: {
    fontSize: 14,
    color: Color.GRAY_DARK,
    fontWeight: '500',
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
