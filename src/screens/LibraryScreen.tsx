/**
 * LibraryScreen
 *
 * Shows a list of books (audio files) for quick access.
 * Active books are shown first, archived books in a separate section.
 */

import { View, Text, StyleSheet, Alert, SectionList, TouchableOpacity, Image, Pressable, AppState, AppStateStatus } from 'react-native'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useStore } from '../store'
import IconButton from '../components/shared/IconButton'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import InputHeader from '../components/shared/InputHeader'
import EmptyState from '../components/shared/EmptyState'
import ActionMenu, { ActionMenuItem } from '../components/shared/ActionMenu'
import { Color } from '../theme'
import type { Book } from '../services'
import { formatTime, formatDate, MAIN_PLAYER_OWNER_ID } from '../utils'

const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export default function LibraryScreen() {
  const router = useRouter()
  const { loadFileWithPicker, fetchBooks, play, books, archiveBook, sync, autoSync } = useStore()
  const [menuBookId, setMenuBookId] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const lastSyncRef = useRef<number>(0)

  useFocusEffect(
    useCallback(() => {
      fetchBooks()
    }, [fetchBooks])
  )

  // Auto-sync when app returns to foreground
  useEffect(() => {
    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        const now = Date.now()
        const timeSinceLastSync = now - lastSyncRef.current

        // Throttle: at least 5 minutes since last sync attempt
        const shouldAttempt =
          timeSinceLastSync > AUTO_SYNC_MIN_INTERVAL_MS &&
          (sync.pendingCount > 0 || !sync.lastSyncTime || now - sync.lastSyncTime > AUTO_SYNC_MIN_INTERVAL_MS)

        if (shouldAttempt) {
          lastSyncRef.current = now
          await autoSync()
        }
      }
    }

    const subscription = AppState.addEventListener('change', handleAppStateChange)
    return () => subscription.remove()
  }, [autoSync, sync.pendingCount, sync.lastSyncTime])

  const handleLoadFile = async () => {
    try {
      await loadFileWithPicker()
      fetchBooks()
    } catch (error) {
      console.error(error)
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

  const handleBookPress = async (book: Book) => {
    if (!book.uri) {
      Alert.alert('Book Unavailable', 'This book has been archived')
      return
    }

    try {
      await play({ fileUri: book.uri, position: book.position, ownerId: MAIN_PLAYER_OWNER_ID })
      router.push('/player')
    } catch (error) {
      console.error('Error loading book:', error)
      Alert.alert('Error', 'Failed to load book')
    }
  }

  const handleOpenMenu = (bookId: string) => {
    setMenuBookId(bookId)
  }

  const handleCloseMenu = () => {
    setMenuBookId(null)
  }

  const handleArchiveBook = (bookId: string) => {
    const book = books[bookId]
    Alert.alert(
      'Archive Book',
      `Archive "${book?.title || book?.name}"? The audio file will be deleted but your clips will be preserved.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: async () => {
            try {
              await archiveBook(bookId)
            } catch (error) {
              console.error('Error archiving book:', error)
              Alert.alert('Error', 'Failed to archive book')
            }
          },
        },
      ]
    )
  }

  const handleMenuAction = (action: string) => {
    if (menuBookId === null) return
    const bookId = menuBookId
    handleCloseMenu()

    switch (action) {
      case 'archive':
        handleArchiveBook(bookId)
        break
    }
  }

  const getMenuItems = (): ActionMenuItem[] => {
    return [
      { key: 'archive', label: 'Archive', icon: 'archive-outline', destructive: true },
    ]
  }

  const handleOpenSearch = () => {
    setIsSearching(true)
  }

  const handleCloseSearch = () => {
    setIsSearching(false)
    setSearchQuery('')
  }

  // Filter and split books into active and archived
  const booksArray = Object.values(books).filter((book) => {
    if (!searchQuery) return true
    const query = searchQuery.toLowerCase()
    return (
      book.title?.toLowerCase().includes(query) ||
      book.name.toLowerCase().includes(query) ||
      book.artist?.toLowerCase().includes(query)
    )
  })
  const activeBooks = booksArray.filter(book => book.uri !== null)
  const archivedBooks = booksArray.filter(book => book.uri === null)

  // Build sections for SectionList
  const sections = [
    ...(activeBooks.length > 0 ? [{ title: null, data: activeBooks }] : []),
    ...(archivedBooks.length > 0 ? [{ title: 'Archived', data: archivedBooks }] : []),
  ]

  return (
    <ScreenArea>
      {isSearching
        ? <InputHeader
            value={searchQuery}
            onChangeText={setSearchQuery}
            onClose={handleCloseSearch}
          />

        : <Header title="Library">
            <View style={styles.headerButtons}>
              <TouchableOpacity onPress={() => router.push('/settings')}>
                <Ionicons name="settings-outline" size={24} color={Color.BLACK} />
              </TouchableOpacity>

              <TouchableOpacity onPress={handleOpenSearch}>
                <Ionicons name="search" size={24} color={Color.BLACK} />
              </TouchableOpacity>
            </View>
          </Header>
      }

      {booksArray.length > 0 ? (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderSectionHeader={({ section }) => (
            section.title
              ? <Text style={styles.sectionHeader}>{section.title}</Text>
              : null
          )}
          renderItem={({ item }) => {
            const isArchived = item.uri === null
            return (
              <TouchableOpacity
                style={[styles.bookItem, isArchived && styles.bookItemArchived]}
                onPress={() => handleBookPress(item)}
                activeOpacity={0.7}
              >
                {/* Artwork */}
                {item.artwork ? (
                  <Image
                    source={{ uri: item.artwork }}
                    style={[styles.artwork, isArchived && styles.artworkArchived]}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={[styles.artworkPlaceholder, isArchived && styles.artworkArchived]}>
                    <Text style={styles.artworkPlaceholderIcon}>🎵</Text>
                  </View>
                )}

                {/* Book Info */}
                <View style={styles.bookInfo}>
                  <Text style={[styles.bookName, isArchived && styles.textArchived]} numberOfLines={1}>
                    {item.title || item.name}
                  </Text>
                  {item.artist && (
                    <Text style={[styles.bookArtist, isArchived && styles.textArchived]} numberOfLines={1}>
                      {item.artist}
                    </Text>
                  )}
                  <View style={styles.bookMetadata}>
                    {item.duration > 0 && (
                      <Text style={[styles.bookDuration, isArchived && styles.textArchived]}>
                        {formatTime(item.duration)}
                      </Text>
                    )}
                    {!isArchived && item.position > 0 && (
                      <Text style={styles.bookProgress}>
                        • {Math.round((item.position / item.duration) * 100)}% played
                      </Text>
                    )}
                  </View>

                  <Text style={[styles.bookDate, isArchived && styles.textArchived]}>
                    {formatDate(item.updated_at)}
                  </Text>
                </View>

                {/* Menu button - only for active books */}
                {!isArchived && (
                  <Pressable
                    style={styles.menuButton}
                    onPress={() => handleOpenMenu(item.id)}
                    hitSlop={8}
                  >
                    <Ionicons name="ellipsis-vertical" size={20} color={Color.GRAY_DARK} />
                  </Pressable>
                )}
              </TouchableOpacity>
            )
          }}
        />
      ) : searchQuery ? (
        <EmptyState
          title="No books found"
          subtitle="Nothing matches your search"
        />
      ) : (
        <EmptyState
          title="No books yet"
          subtitle="Open an audio file to add it to your library"
        />
      )}

      <ActionMenu
        visible={menuBookId !== null}
        onClose={handleCloseMenu}
        onAction={handleMenuAction}
        items={getMenuItems()}
      />


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
  headerButtons: {
    flexDirection: 'row',
    gap: 16,
  },
  listContent: {
    padding: 16,
    paddingBottom: 80, // Space for FAB
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '600',
    color: Color.GRAY_DARK,
    marginTop: 16,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  bookItem: {
    flexDirection: 'row',
    backgroundColor: Color.GRAY_LIGHTER,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
    gap: 12,
  },
  bookItemArchived: {
    opacity: 0.6,
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
  artworkArchived: {
    opacity: 0.7,
  },
  bookInfo: {
    flex: 1,
    gap: 4,
  },
  bookName: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.BLACK,
  },
  bookArtist: {
    fontSize: 14,
    color: Color.GRAY_DARK,
    fontWeight: '500',
  },
  bookMetadata: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bookDuration: {
    fontSize: 14,
    color: Color.GRAY_DARK,
  },
  bookProgress: {
    fontSize: 14,
    color: Color.PRIMARY,
  },
  bookDate: {
    fontSize: 12,
    color: Color.GRAY_MEDIUM,
    marginTop: 2,
  },
  textArchived: {
    color: Color.GRAY,
  },
  menuButton: {
    padding: 0,
    justifyContent: 'flex-start',
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
