/**
 * ClipsListScreen
 *
 * Lists all clips/bookmarks from all audio files.
 * Each clip shows which file it belongs to.
 */

import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  Pressable,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useState, useCallback, useMemo } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'

import { useStore } from '../store'
import { Color } from '../theme'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import InputHeader from '../components/shared/InputHeader'
import EmptyState from '../components/shared/EmptyState'
import ActionMenu, { ActionMenuItem } from '../components/shared/ActionMenu'
import Dialog from '../components/shared/Dialog'
import ClipViewer from '../components/ClipViewer'
import ClipEditor from '../components/ClipEditor'
import { formatTime } from '../utils'


export default function ClipsListScreen() {
  const router = useRouter()
  const { clips, transcription, seekClip, deleteClip, updateClip, shareClip, fetchClips } = useStore()
  const [viewingClipId, setViewingClipId] = useState<string | null>(null)
  const [editingClipId, setEditingClipId] = useState<string | null>(null)
  const [menuClipId, setMenuClipId] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Fetch all clips when screen is focused
  useFocusEffect(
    useCallback(() => {
      fetchClips()
    }, [fetchClips])
  )

  const sortedClips = useMemo(() =>
    Object.values(clips)
      .filter((clip) => {
        if (!searchQuery) return true
        const query = searchQuery.toLowerCase()
        return (
          clip.file_title?.toLowerCase().includes(query) ||
          clip.file_name.toLowerCase().includes(query) ||
          clip.transcription?.toLowerCase().includes(query) ||
          clip.note?.toLowerCase().includes(query)
        )
      })
      .sort((a, b) => b.created_at - a.created_at),
    [clips, searchQuery]
  )

  const viewingClip = viewingClipId ? clips[viewingClipId] : null
  const editingClip = editingClipId ? clips[editingClipId] : null

  const handleJumpToClip = async (clipId: string) => {
    try {
      await seekClip(clipId)
      router.replace('/player')
    } catch (error) {
      console.error('Error jumping to clip:', error)
      Alert.alert('Error', 'Failed to jump to clip')
    }
  }

  const handleDeleteClip = (clipId: string) => {
    Alert.alert(
      'Delete Clip',
      'Are you sure you want to delete this clip?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteClip(clipId),
        },
      ]
    )
  }

  const handleViewClip = (clipId: string) => {
    if (clipId in clips) {
      setViewingClipId(clipId)
    }
  }

  const handleCloseViewClip = () => {
    setViewingClipId(null)
  }

  const handleEditClip = (clipId: string) => {
    if (clipId in clips) {
      setViewingClipId(null)
      setEditingClipId(clipId)
    }
  }

  const handleSaveClip = (updates: { note?: string; start?: number; duration?: number }) => {
    if (editingClipId) {
      updateClip(editingClipId, updates)
      setEditingClipId(null)
    }
  }

  const handleCancelEditClip = () => {
    setEditingClipId(null)
  }

  const handleShareClip = async (clipId: string) => {
    try {
      await shareClip(clipId)
    } catch (error) {
      console.error('Error sharing clip:', error)
      Alert.alert('Error', 'Failed to share clip')
    }
  }

  const handleOpenMenu = (clipId: string) => {
    setMenuClipId(clipId)
  }

  const handleCloseMenu = () => {
    setMenuClipId(null)
  }

  const handleOpenSearch = () => {
    setIsSearching(true)
  }

  const handleCloseSearch = () => {
    setIsSearching(false)
    setSearchQuery('')
  }

  const handleMenuAction = (action: string) => {
    if (menuClipId === null) return
    const clipId = menuClipId
    handleCloseMenu()

    switch (action) {
      case 'edit':
        handleEditClip(clipId)
        break
      case 'goToSource':
        handleJumpToClip(clipId)
        break
      case 'share':
        handleShareClip(clipId)
        break
      case 'delete':
        handleDeleteClip(clipId)
        break
    }
  }

  const getMenuItems = (): ActionMenuItem[] => {
    const clip = menuClipId ? clips[menuClipId] : null
    const hasSourceFile = clip?.file_uri !== null

    return [
      // Edit and Go to source require source file
      ...(hasSourceFile ? [
        { key: 'edit', label: 'Edit', icon: 'pencil' } as ActionMenuItem,
        { key: 'goToSource', label: 'Go to source', icon: 'play-circle-outline' } as ActionMenuItem,
      ] : []),
      { key: 'share', label: 'Share', icon: 'share-outline' },
      { key: 'delete', label: 'Delete', icon: 'trash-outline', destructive: true },
    ]
  }

  return (
    <ScreenArea>
      {isSearching
        ? <InputHeader
            value={searchQuery}
            onChangeText={setSearchQuery}
            onClose={handleCloseSearch}
          />

        : <Header title="Clips">
            <TouchableOpacity onPress={handleOpenSearch}>
              <Ionicons name="search" size={24} color={Color.BLACK} />
            </TouchableOpacity>
          </Header>
      }

      {sortedClips.length > 0
        ? <ClipList
            clips={sortedClips}
            pending={transcription.pending}
            onViewClip={handleViewClip}
            onOpenMenu={handleOpenMenu}
          /> :

       searchQuery.length > 0
        ? <EmptyState title="No clips found" subtitle="Nothing matches your search" />
        : <EmptyState title="No clips yet" subtitle="Add clips from the player screen" />
      }

      {viewingClip && (
        <Dialog visible onClose={handleCloseViewClip}>
          <ClipViewer
            clip={viewingClip}
            onClose={handleCloseViewClip}
            onEdit={() => handleEditClip(viewingClip.id)}
          />
        </Dialog>
      )}

      {editingClip && (
        <Dialog visible onClose={handleCancelEditClip}>
          <ClipEditor
            clip={editingClip}
            onCancel={handleCancelEditClip}
            onSave={handleSaveClip}
          />
        </Dialog>
      )}

      <ActionMenu
        visible={menuClipId !== null}
        onClose={handleCloseMenu}
        onAction={handleMenuAction}
        items={getMenuItems()}
      />
    </ScreenArea>
  )
}


function ClipList({ clips, pending, onViewClip, onOpenMenu }: any) {
  return (
    <FlatList
      data={clips}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.clipItem}
          onPress={() => onViewClip(item.id)}
          activeOpacity={0.7}
          testID="clip-card"
        >
          <View style={styles.clipContent}>
            <Text style={styles.clipFileLabel} numberOfLines={1}>
              {item.file_title || item.file_name}
            </Text>

            <View style={styles.clipHeader}>
              <Text style={styles.clipTime}>{formatTime(item.start)}</Text>
              {item.duration > 0 && (
                <Text style={styles.clipDuration}>
                  ({formatTime(item.duration)})
                </Text>
              )}
            </View>
            {pending[item.id] ? (
              <Text style={styles.clipTranscription} numberOfLines={2}>
                Transcribing...
              </Text>
            ) : null}
            {item.transcription ? (
              <Text style={styles.clipTranscription} numberOfLines={2}>
                &ldquo;{item.transcription} ...&rdquo;
              </Text>
            ) : null}
            {item.note && <Text style={styles.clipNote}>{item.note}</Text>}
          </View>

          <Pressable
            style={styles.menuButton}
            onPress={() => onOpenMenu(item.id)}
            hitSlop={8}
            testID="clip-menu-button"
          >
            <Ionicons name="ellipsis-vertical" size={20} color={Color.GRAY_DARK} />
          </Pressable>
        </TouchableOpacity>
      )}
    />
  )
}


const styles = StyleSheet.create({
  listContent: {
    padding: 16,
  },
  clipItem: {
    flexDirection: 'row',
    backgroundColor: Color.GRAY_LIGHTER,
    borderRadius: 8,
    marginBottom: 16,
  },
  clipContent: {
    flex: 1,
    padding: 16,
  },
  clipFileLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Color.GRAY_DARK,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  clipHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  clipTime: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.PRIMARY,
  },
  clipDuration: {
    fontSize: 14,
    color: Color.GRAY_DARK,
  },
  clipTranscription: {
    fontSize: 14,
    fontStyle: 'italic',
    color: Color.GRAY_DARK,
    marginTop: 4,
  },
  clipNote: {
    fontSize: 14,
    color: Color.GRAY_DARKER,
    marginTop: 4,
  },
  menuButton: {
    padding: 16,
    justifyContent: 'flex-start',
  },
})
