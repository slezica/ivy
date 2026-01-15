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
import type { AudioFile } from '../services'
import { formatTime, formatDate } from '../utils'

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

  // Dev-only: Long-press FAB to load test file (for Maestro tests)
  const handleLoadTestFile = __DEV__
    ? async () => {
        try {
          const { Asset } = await import('expo-asset')
          const asset = Asset.fromModule(require('../../assets/test/test-audio.mp3'))
          await asset.downloadAsync()
          if (!asset.localUri) throw new Error('Failed to download test asset')
          await loadFileWithUri(asset.localUri, 'test-audio.mp3')
          fetchFiles()
          router.push('/player')
        } catch (error) {
          console.error('Error loading test file:', error)
          Alert.alert('Error', 'Failed to load test file')
        }
      }
    : undefined

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
        <View style={styles.devButtons}>
          {__DEV__ && handleLoadTestFile && (
            <TouchableOpacity
              style={styles.devButton}
              onPress={handleLoadTestFile}
            >
              <Text style={styles.devButtonText}>Sample</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.devButton, styles.devResetButton]}
            onPress={handleDevReset}
          >
            <Text style={styles.devButtonText}>Reset</Text>
          </TouchableOpacity>
        </View>
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
          testID="fab-add-file"
          size={56}
          style={styles.fab}
        />
      </View>
    </ScreenArea>
  )
}

const styles = StyleSheet.create({
  devButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  devButton: {
    backgroundColor: Color.GRAY_DARK,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  devResetButton: {
    backgroundColor: Color.DESTRUCTIVE,
  },
  devButtonText: {
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
