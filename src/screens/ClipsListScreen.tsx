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
  SafeAreaView,
  Alert,
  Modal,
  TextInput,
  Platform,
  StatusBar,
} from 'react-native'
import { useState } from 'react'
import { useRouter, useFocusEffect } from 'expo-router'
import { useCallback } from 'react'

import { useStore } from '../store'
import { Color } from '../theme'
import { ClipWithFile } from '../services/DatabaseService'


export default function ClipsListScreen() {
  const router = useRouter()
  const { clips, player, jumpToClip, deleteClip, updateClip, shareClip, fetchAllClips } = useStore()
  const [editingClipId, setEditingClipId] = useState<number | null>(null)
  const [sharingClipId, setSharingClipId] = useState<number | null>(null)

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

  const handleSaveClip = ({ note }: ClipWithFile) => {
    if (editingClipId) {
      updateClip(editingClipId, note)
      setEditingClipId(null)
    }
  }

  const handleCancelEditClip = () => {
    setEditingClipId(null)
  }

  const handleShareClip = async (clipId: number) => {
    setSharingClipId(clipId)
    try {
      await shareClip(clipId)
    } catch (error) {
      console.error('Error sharing clip:', error)
      Alert.alert('Error', 'Failed to share clip')
    } finally {
      setSharingClipId(null)
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>All Clips</Text>
        <Text style={styles.subtitle}>From all audio files</Text>
      </View>

      {clipsArray.length > 0
        ? <ClipList
          clips={clipsArray}
          onJumpToClip={handleJumpToClip}
          onEditClip={handleEditClip}
          onDeleteClip={handleDeleteClip}
          onShareClip={handleShareClip}
          sharingClipId={sharingClipId} />

        : <EmptyList />
      }

      { editingClipId != null && 
        <EditClipModal
          clip={clips[editingClipId]}
          visible={true}
          onCancel={handleCancelEditClip}
          onSave={handleSaveClip}
        />
      }
    </SafeAreaView>
  )
}


function ClipList({ clips, onJumpToClip, onEditClip, onDeleteClip, onShareClip, sharingClipId }: any) {
  return (
    <FlatList
      data={clips}
      keyExtractor={(item) => item.id.toString()}
      contentContainerStyle={styles.listContent}
      renderItem={({ item }) => (
        <View style={styles.clipItem}>
          <TouchableOpacity
            style={styles.clipContent}
            onPress={() => onJumpToClip(item.id)}
          >
            {/* File label */}
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
            {item.note && <Text style={styles.clipNote}>{item.note}</Text>}
          </TouchableOpacity>

          <View style={styles.clipActions}>
            <TouchableOpacity
              style={styles.editButton}
              onPress={() => onEditClip(item.id)}
            >
              <Text style={styles.editButtonText}>{item.note ? "Edit note" : "Add note"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.shareButton}
              onPress={() => onShareClip(item.id)}
              disabled={sharingClipId === item.id}
            >
              <Text style={styles.shareButtonText}>
                {sharingClipId === item.id ? 'Sharing...' : 'Share'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => onDeleteClip(item.id)}
            >
              <Text style={styles.deleteButtonText}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    />
  )
}


function EmptyList() {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>No clips yet</Text>
      <Text style={styles.emptySubtext}>
        Add clips from the player screen
      </Text>
    </View>
  )
}


function EditClipModal({ visible, clip, formNote, onCancel, onSave }: any) {
  const [form, setForm] = useState({
    note: clip.note
  })

  const handleNoteChange = (note: string) => {
    setForm({ ...form, note })
  }

  const handleSave = () => {
    onSave({ ...clip, ...form })
  }

  const handleCancel = () => {
    onCancel()
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Edit Clip</Text>

          <Text style={styles.modalSubtitle}>
            at {formatTime(clip.start)}
          </Text>

          <TextInput
            style={styles.modalInput}
            placeholder="Add note (optional)"
            value={form.note}
            onChangeText={handleNoteChange}
            autoFocus
            multiline
          />

          <View style={styles.modalButtons}>
            <TouchableOpacity
              style={[styles.modalButton, styles.modalCancelButton]}
              onPress={handleCancel}
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
    marginTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: Color.GRAY_DARK,
  },
  listContent: {
    padding: 16,
  },
  clipItem: {
    backgroundColor: Color.GRAY_LIGHTER,
    borderRadius: 8,
    marginBottom: 24,
    overflow: 'hidden',
  },
  clipContent: {
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
  clipNote: {
    fontSize: 14,
    color: Color.GRAY_DARKER,
    marginTop: 4,
  },
  clipActions: {
    flexDirection: 'row',
  },
  editButton: {
    backgroundColor: Color.PRIMARY,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    flex: 1,
  },
  editButtonText: {
    color: Color.WHITE,
    fontSize: 14,
    fontWeight: '600',
  },
  shareButton: {
    backgroundColor: Color.PRIMARY,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    flex: 1,
  },
  shareButtonText: {
    color: Color.WHITE,
    fontSize: 14,
    fontWeight: '600',
  },
  deleteButton: {
    backgroundColor: Color.DESTRUCTIVE,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    flex: 1,
  },
  deleteButtonText: {
    color: Color.WHITE,
    fontSize: 14,
    fontWeight: '600',
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
    padding: 20,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 14,
    color: Color.GRAY_DARK,
    marginBottom: 16,
  },
  modalInput: {
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
