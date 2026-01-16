/**
 * ClipEditor
 *
 * Edit clip bounds and note with selection timeline.
 */

import { useState, useRef, useEffect } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native'

import { useStore } from '../store'
import { Color } from '../theme'
import { formatTime } from '../utils'
import Header from './shared/Header'
import IconButton from './shared/IconButton'
import { SelectionTimeline } from './timeline'
import type { ClipWithFile } from '../services'


interface ClipEditorProps {
  clip: ClipWithFile
  onCancel: () => void
  onSave: (updates: { note?: string; start?: number; duration?: number }) => void
}

export default function ClipEditor({ clip, onCancel, onSave }: ClipEditorProps) {
  const { player, play, pause, seek } = useStore()

  const [note, setNote] = useState(clip.note)
  const [selectionStart, setSelectionStart] = useState(clip.start)
  const [selectionEnd, setSelectionEnd] = useState(clip.start + clip.duration)

  // Local position state - this is what the user is scrubbing to
  const [localPosition, setLocalPosition] = useState(clip.start)

  // Stable owner ID for this instance
  const ownerId = useRef(`clip-editor-${clip.id}`).current

  // Check ownership and file state from global player
  const isFileLoaded = player.file?.uri === clip.source_uri
  const isOwner = player.ownerId === ownerId
  const isPlaying = isOwner && player.status === 'playing'
  const isLoading = isOwner && (player.status === 'loading' || player.status === 'adding')

  // Display position: use global when we own playback, otherwise local
  const displayPosition = isOwner && isFileLoaded ? player.position : localPosition

  // Sync local position from player when we own playback
  useEffect(() => {
    if (isOwner && isFileLoaded) {
      setLocalPosition(player.position)
    }
  }, [isOwner, isFileLoaded, player.position])

  const handleSelectionChange = (start: number, end: number) => {
    setSelectionStart(start)
    setSelectionEnd(end)
  }

  const handleSeek = async (pos: number) => {
    // Always update local position
    setLocalPosition(pos)

    // If our file is loaded and we own playback, also seek the global player
    if (isFileLoaded && isOwner) {
      await seek({ fileUri: clip.source_uri, position: pos })
    }
  }

  const handlePlayPause = async () => {
    try {
      if (isPlaying) {
        await pause()
      } else {
        // Take ownership and play with our file and local position
        await play({ fileUri: clip.source_uri, position: localPosition, ownerId })
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
    <>
      <Header
        title="Edit Clip"
        subtitle={`${formatTime(selectionStart)} - ${formatTime(selectionEnd)}`}
        noBorder
      />

      <SelectionTimeline
        duration={clip.file_duration}
        position={displayPosition}
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
        style={styles.input}
        placeholder="Add note (optional)"
        placeholderTextColor={Color.GRAY}
        value={note}
        onChangeText={setNote}
        multiline
      />

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={onCancel}
        >
          <Text style={styles.buttonText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.primaryButton]}
          onPress={handleSave}
        >
          <Text style={[styles.buttonText, styles.primaryButtonText]}>Save</Text>
        </TouchableOpacity>
      </View>
    </>
  )
}


const styles = StyleSheet.create({
  playButtonContainer: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  input: {
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
  buttons: {
    flexDirection: 'row',
    gap: 12,
    padding: 20,
    paddingTop: 0,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  secondaryButton: {
    backgroundColor: Color.GRAY_LIGHTER,
  },
  primaryButton: {
    backgroundColor: Color.PRIMARY,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.GRAY_DARKER,
  },
  primaryButtonText: {
    color: Color.WHITE,
  },
})
