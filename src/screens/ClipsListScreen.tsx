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
  Modal,
  TextInput,
  Pressable,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useState, useEffect } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useCallback } from 'react'

import { useStore } from '../store'
import { Color } from '../theme'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import EmptyState from '../components/shared/EmptyState'
import ActionMenu, { ActionMenuItem } from '../components/shared/ActionMenu'
import IconButton from '../components/shared/IconButton'
import { SelectionTimeline } from '../components/timeline'
import type { ClipWithFile } from '../services'
import { formatTime } from '../utils'


export default function ClipsListScreen() {
  const router = useRouter()
  const { clips, jumpToClip, deleteClip, updateClip, shareClip, fetchAllClips } = useStore()
  const [editingClipId, setEditingClipId] = useState<number | null>(null)
  const [menuClipId, setMenuClipId] = useState<number | null>(null)

  // Fetch all clips when screen is focused
  useFocusEffect(
    useCallback(() => {
      fetchAllClips()
    }, [fetchAllClips])
  )

  const clipsArray = Object.values(clips).sort((a, b) => b.created_at - a.created_at)
  const editingClip = editingClipId ? clips[editingClipId] : null

  const handleJumpToClip = async (clipId: number) => {
    try {
      await jumpToClip(clipId)
      router.back()
    } catch (error) {
      console.error('Error jumping to clip:', error)
      Alert.alert('Error', 'Failed to jump to clip')
    }
  }

  const handleDeleteClip = (clipId: number) => {
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

  const handleEditClip = (clipId: number) => {
    if (clipId in clips) {
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

  const handleShareClip = async (clipId: number) => {
    try {
      await shareClip(clipId)
    } catch (error) {
      console.error('Error sharing clip:', error)
      Alert.alert('Error', 'Failed to share clip')
    }
  }

  const handleOpenMenu = (clipId: number) => {
    setMenuClipId(clipId)
  }

  const handleCloseMenu = () => {
    setMenuClipId(null)
  }

  const handleMenuAction = (action: string) => {
    if (menuClipId === null) return
    const clipId = menuClipId
    handleCloseMenu()

    switch (action) {
      case 'edit':
        handleEditClip(clipId)
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
    const clip = menuClipId !== null ? clips[menuClipId] : null
    return [
      { key: 'edit', label: clip?.note ? 'Edit note' : 'Add note', icon: 'pencil' },
      { key: 'share', label: 'Share', icon: 'share-outline' },
      { key: 'delete', label: 'Delete', icon: 'trash-outline', destructive: true },
    ]
  }

  return (
    <ScreenArea>
      <Header title="Clips" />

      {clipsArray.length > 0
        ? <ClipList
            clips={clipsArray}
            onJumpToClip={handleJumpToClip}
            onOpenMenu={handleOpenMenu}
          />
        : <EmptyState title="No clips yet" subtitle="Add clips from the player screen" />
      }

      {editingClipId != null &&
        <EditClipModal
          clip={clips[editingClipId]}
          visible={true}
          onCancel={handleCancelEditClip}
          onSave={handleSaveClip}
        />
      }

      <ActionMenu
        visible={menuClipId !== null}
        onClose={handleCloseMenu}
        onAction={handleMenuAction}
        items={getMenuItems()}
      />
    </ScreenArea>
  )
}


function ClipList({ clips, onJumpToClip, onOpenMenu }: any) {
  return (
    <FlatList
      data={clips}
      keyExtractor={(item) => item.id.toString()}
      contentContainerStyle={styles.listContent}
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.clipItem}
          onPress={() => onJumpToClip(item.id)}
          activeOpacity={0.7}
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
            {item.transcription ? (
              <Text style={styles.clipTranscription} numberOfLines={2}>
                "{item.transcription}"
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


interface EditClipModalProps {
  visible: boolean
  clip: ClipWithFile
  onCancel: () => void
  onSave: (updates: { note?: string; start?: number; duration?: number }) => void
}

function EditClipModal({ visible, clip, onCancel, onSave }: EditClipModalProps) {
  const { player, play, pause, seek, loadFileWithUri } = useStore()

  const [note, setNote] = useState(clip.note)
  const [selectionStart, setSelectionStart] = useState(clip.start)
  const [selectionEnd, setSelectionEnd] = useState(clip.start + clip.duration)

  // Check if the clip's file is currently loaded
  const isFileLoaded = player.file?.uri === clip.file_uri
  const isPlaying = isFileLoaded && player.status === 'playing'
  const isLoading = player.status === 'loading' || player.status === 'adding'

  // Use player position when file is loaded, otherwise use local state
  const [localPosition, setLocalPosition] = useState(clip.start)
  const position = isFileLoaded ? player.position : localPosition

  const handleSelectionChange = (start: number, end: number) => {
    setSelectionStart(start)
    setSelectionEnd(end)
  }

  const handleSeek = async (pos: number) => {
    if (isFileLoaded) {
      await seek(pos)
    } else {
      setLocalPosition(pos)
    }
  }

  const handlePlayPause = async () => {
    try {
      if (!isFileLoaded) {
        // Load the clip's file first
        await loadFileWithUri(clip.file_uri, clip.file_name)
        // Seek to selection start after loading
        await seek(selectionStart)
        await play()
      } else if (isPlaying) {
        await pause()
      } else {
        await play()
      }
    } catch (error) {
      console.error('Error toggling playback:', error)
    }
  }

  const handleSave = () => {
    const newDuration = selectionEnd - selectionStart
    onSave({
      note,
      start: selectionStart,
      duration: newDuration,
    })
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Header
            title="Edit Clip"
            subtitle={`${formatTime(selectionStart)} - ${formatTime(selectionEnd)}`}
            noBorder
          />

          <SelectionTimeline
            duration={clip.file_duration}
            position={position}
            selectionStart={selectionStart}
            selectionEnd={selectionEnd}
            onSelectionChange={handleSelectionChange}
            onSeek={handleSeek}
            showTime="hidden"
          />

          <View style={styles.playButtonContainer}>
            <IconButton
              iconName={isPlaying ? 'pause' : 'play'}
              onPress={handlePlayPause}
              size={48}
              backgroundColor={isLoading ? Color.GRAY : Color.PRIMARY}
            />
          </View>

          <TextInput
            style={styles.modalInput}
            placeholder="Add note (optional)"
            placeholderTextColor={Color.GRAY}
            value={note}
            onChangeText={setNote}
            multiline
          />

          <View style={styles.modalButtons}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalCancelButton]}
              onPress={onCancel}
            >
              <Text style={styles.modalButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalSaveButton]}
              onPress={handleSave}
            >
              <Text style={[styles.modalButtonText, styles.modalSaveButtonText]}>
                Save
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
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
  modalOverlay: {
    flex: 1,
    backgroundColor: Color.MODAL_OVERLAY,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: Color.WHITE,
    borderRadius: 12,
    width: '100%',
    maxWidth: 400,
    overflow: 'hidden',
  },
  playButtonContainer: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  modalInput: {
    marginHorizontal: 20,
    borderWidth: 1,
    borderColor: Color.GRAY_BORDER,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 20,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    padding: 20,
    paddingTop: 0,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalCancelButton: {
    backgroundColor: Color.GRAY_LIGHTER,
  },
  modalSaveButton: {
    backgroundColor: Color.PRIMARY,
  },
  modalButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.GRAY_DARKER,
  },
  modalSaveButtonText: {
    color: Color.WHITE,
  },
})
