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
import { Timeline } from './timeline'
import type { ClipWithFile } from '../services'


interface ClipEditorProps {
  clip: ClipWithFile
  onCancel: () => void
  onSave: (updates: { note?: string; start?: number; duration?: number }) => void
}

export default function ClipEditor({ clip, onCancel, onSave }: ClipEditorProps) {
  const { playback, play, pause, seek } = useStore()

  // ClipEditor requires source file to exist (editing disabled otherwise)
  const fileUri = clip.file_uri!

  const [note, setNote] = useState(clip.note)
  const [selectionStart, setSelectionStart] = useState(clip.start)
  const [selectionEnd, setSelectionEnd] = useState(clip.start + clip.duration)

  // Local state - the position this editor remembers
  const [ownPosition, setOwnPosition] = useState(clip.start)

  // Stable owner ID for this instance
  const ownerId = useRef(`clip-editor-${clip.id}`).current

  // Check ownership and file state from global playback
  const isFileLoaded = playback.uri === fileUri
  const isOwner = playback.ownerId === ownerId
  const isPlaying = isOwner && playback.status === 'playing'
  const isLoading = isOwner && playback.status === 'loading'

  // Stop playback when dismissed
  useEffect(() => {
    return () => { pause() }
  }, [])

  // Sync position from playback when we own playback
  useEffect(() => {
    if (isOwner && isFileLoaded) {
      setOwnPosition(playback.position)
    }
  }, [isOwner, isFileLoaded, playback.position])

  const handleSelectionChange = (start: number, end: number) => {
    setSelectionStart(start)
    setSelectionEnd(end)
  }

  const handleSeek = async (pos: number) => {
    // Always update local position
    setOwnPosition(pos)

    // Only affect playback if we're the owner and file is loaded
    if (isOwner && isFileLoaded) {
      await seek({ fileUri, position: pos })
    }
  }

  const handlePlayPause = async () => {
    try {
      if (isPlaying) {
        await pause()
      } else {
        // Claim ownership and play from our remembered position
        await play({ fileUri, position: ownPosition, ownerId })
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

      <Timeline
        duration={clip.file_duration}
        position={ownPosition}
        onSeek={handleSeek}
        leftColor={Color.PRIMARY}
        rightColor={Color.PRIMARY}
        selectionColor={Color.SELECTION}
        selectionStart={selectionStart}
        selectionEnd={selectionEnd}
        onSelectionChange={handleSelectionChange}
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
