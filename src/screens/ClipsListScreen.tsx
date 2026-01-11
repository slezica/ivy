/**
 * ClipsListScreen
 *
 * Lists all clips/bookmarks for the current file.
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
} from 'react-native'
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { useStore } from '../store'
import { Color } from '../theme'

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

export default function ClipsListScreen() {
  const router = useRouter()
  const { clips, file, jumpToClip, deleteClip, updateClip } = useStore()
  const [editingClipId, setEditingClipId] = useState<number | null>(null)
  const [editNote, setEditNote] = useState('')

  const clipsArray = Object.values(clips).sort((a, b) => a.start - b.start)
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
    const clip = clips[clipId]
    if (clip) {
      setEditNote(clip.note)
      setEditingClipId(clipId)
    }
  }

  const handleSaveEdit = () => {
    if (editingClipId) {
      updateClip(editingClipId, editNote)
      setEditingClipId(null)
      setEditNote('')
      Alert.alert('Success', 'Clip updated')
    }
  }

  const handleCancelEdit = () => {
    setEditingClipId(null)
    setEditNote('')
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Clips</Text>
        {file && <Text style={styles.subtitle}>{file.name}</Text>}
      </View>

      {clipsArray.length > 0 ? (
        <FlatList
          data={clipsArray}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <View style={styles.clipItem}>
              <TouchableOpacity
                style={styles.clipContent}
                onPress={() => handleJumpToClip(item.id)}
              >
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
                  onPress={() => handleEditClip(item.id)}
                >
                  <Text style={styles.editButtonText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.deleteButton}
                  onPress={() => handleDeleteClip(item.id)}
                >
                  <Text style={styles.deleteButtonText}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>No clips yet</Text>
          <Text style={styles.emptySubtext}>
            Add clips from the player screen
          </Text>
        </View>
      )}

      <Modal
        visible={editingClipId !== null}
        transparent
        animationType="fade"
        onRequestClose={handleCancelEdit}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Edit Clip</Text>
            {editingClip && (
              <Text style={styles.modalSubtitle}>
                at {formatTime(editingClip.start)}
              </Text>
            )}

            <TextInput
              style={styles.modalInput}
              placeholder="Add note (optional)"
              value={editNote}
              onChangeText={setEditNote}
              autoFocus
              multiline
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalCancelButton]}
                onPress={handleCancelEdit}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalSaveButton]}
                onPress={handleSaveEdit}
              >
                <Text style={[styles.modalButtonText, styles.modalSaveButtonText]}>
                  Save
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  backButton: {
    marginBottom: 8,
  },
  backButtonText: {
    fontSize: 16,
    color: Color.PRIMARY,
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
    backgroundColor: Color.GRAY_LIGHTEST,
    borderRadius: 8,
    marginBottom: 12,
    overflow: 'hidden',
  },
  clipContent: {
    padding: 16,
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
