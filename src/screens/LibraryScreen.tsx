/**
 * LibraryScreen
 *
 * Shows a list of books (audio files) for quick access.
 * Active books are shown first, archived books in a separate section.
 */

import { View, Text, StyleSheet, Alert, SectionList, TouchableOpacity, AppState, AppStateStatus, TextInput } from 'react-native'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useStore } from '../store'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import InputHeader from '../components/shared/InputHeader'
import EmptyState from '../components/shared/EmptyState'
import ActionMenu, { ActionMenuItem } from '../components/shared/ActionMenu'
import TextButton from '../components/shared/TextButton'
import Dialog from '../components/shared/Dialog'
import MetadataEditor from '../components/MetadataEditor'
import BookItem from '../components/BookItem'
import { Color, Space } from '../theme'
import type { Book } from '../services'
import { MAIN_PLAYER_OWNER_ID } from '../utils'

const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export default function LibraryScreen() {
  const router = useRouter()
  const { loadFileWithPicker, loadFromUrl, fetchBooks, play, books, archiveBook, deleteBook, updateBook, sync, autoSync } = useStore()
  const [menuBookId, setMenuBookId] = useState<string | null>(null)
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false)
  const [editingBookId, setEditingBookId] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isUrlDialogOpen, setIsUrlDialogOpen] = useState(false)
  const [urlInput, setUrlInput] = useState('')
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

  const handleDownloadUrl = async () => {
    const url = urlInput.trim()
    if (!url) return

    setIsUrlDialogOpen(false)
    setUrlInput('')

    try {
      await loadFromUrl(url)
      fetchBooks()
    } catch (error) {
      console.error(error)
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
      `Archive "${book?.title || book?.name}" and delete the file? You can re-add it later`,
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

  const handleDeleteBook = (bookId: string) => {
    const book = books[bookId]
    Alert.alert(
      'Remove from Library',
      `Remove "${book?.title || book?.name}" from your library completely?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteBook(bookId)
            } catch (error) {
              console.error('Error removing book:', error)
              Alert.alert('Error', 'Failed to remove book')
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
      case 'edit':
        setEditingBookId(bookId)
        break
      case 'archive':
        handleArchiveBook(bookId)
        break
      case 'delete':
        handleDeleteBook(bookId)
        break
    }
  }

  const getMenuItems = (): ActionMenuItem[] => {
    const book = menuBookId ? books[menuBookId] : null
    const isArchived = book && book.uri === null

    if (isArchived) {
      return [
        { key: 'edit', label: 'Edit details', icon: 'create-outline' },
        { key: 'delete', label: 'Remove from library', icon: 'trash-outline', destructive: true },
      ]
    }

    return [
      { key: 'edit', label: 'Edit details', icon: 'create-outline' },
      { key: 'archive', label: 'Archive', icon: 'archive-outline' },
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
              <TouchableOpacity onPress={handleOpenSearch}>
                <Ionicons name="search" size={24} color={Color.TEXT} />
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setIsHeaderMenuOpen(true)}>
                <Ionicons name="ellipsis-vertical" size={24} color={Color.TEXT} />
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
          renderItem={({ item }) => (
            <BookItem
              book={item}
              onPress={handleBookPress}
              onOpenMenu={handleOpenMenu}
            />
          )}
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

      <ActionMenu
        visible={isHeaderMenuOpen}
        onClose={() => setIsHeaderMenuOpen(false)}
        onAction={(action) => {
          setIsHeaderMenuOpen(false)
          if (action === 'add-file') handleLoadFile()
          if (action === 'download-url') setIsUrlDialogOpen(true)
          if (action === 'history') router.push('/sessions')
          if (action === 'settings') router.push('/settings')
        }}
        items={[
          { key: 'add-file', label: 'Add from files', icon: 'add-outline' },
          { key: 'download-url', label: 'Add from URL', icon: 'cloud-download-outline' },
          { key: 'history', label: 'History', icon: 'time-outline' },
          { key: 'settings', label: 'Settings', icon: 'settings-outline' },
        ]}
      />


      <Dialog visible={isUrlDialogOpen} onClose={() => setIsUrlDialogOpen(false)}>
        <View style={styles.urlDialog}>
          <Text style={styles.urlDialogTitle}>Download URL</Text>
          <TextInput
            style={styles.urlInput}
            placeholder="Paste a URL..."
            value={urlInput}
            onChangeText={setUrlInput}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            selectTextOnFocus
          />
          <View style={styles.urlDialogButtons}>
            <TextButton label="Cancel" onPress={() => { setIsUrlDialogOpen(false); setUrlInput('') }} style={{ flex: 1 }} />
            <TextButton label="Download" variant="primary" onPress={handleDownloadUrl} style={{ flex: 1 }} />
          </View>
        </View>
      </Dialog>

      {editingBookId && books[editingBookId] && (
        <Dialog visible onClose={() => setEditingBookId(null)}>
          <MetadataEditor
            book={books[editingBookId]}
            onCancel={() => setEditingBookId(null)}
            onSave={async (updates) => {
              await updateBook(editingBookId, updates)
              setEditingBookId(null)
            }}
          />
        </Dialog>
      )}

    </ScreenArea>
  )
}

const styles = StyleSheet.create({
  headerButtons: {
    flexDirection: 'row',
    gap: 20,
  },
  listContent: {
    padding: Space.SCREEN_PADDING,
    paddingBottom: Space.SCREEN_PADDING,
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '600',
    color: Color.TEXT_2,
    marginTop: 16,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  urlDialog: {
    padding: 16,
    gap: 16,
  },
  urlDialogTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: Color.TEXT,
  },
  urlInput: {
    borderWidth: 1,
    borderColor: Color.BACKGROUND_3,
    borderRadius: Space.BORDER_RADIUS,
    padding: 12,
    fontSize: 16,
    color: Color.TEXT,
  },
  urlDialogButtons: {
    flexDirection: 'row',
    gap: 12,
  },
})
