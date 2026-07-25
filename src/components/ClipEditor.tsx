/**
 * ClipEditor
 *
 * Edit clip bounds and note with selection timeline.
 *
 * Mode-free: callers map their own semantics onto normalized props —
 * ClipsListScreen edits an existing clip, PlayerScreen drafts a new one.
 * The caller owns the ownerId, so it can claim playback ownership for the
 * editor before mounting it (seamless handoff from the main player).
 */

import { useState, useEffect } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native'

import { useStore } from '../store'
import { Color, Space } from '../theme'
import { formatTime } from '../utils'
import IconButton from './shared/IconButton'
import { Timeline } from './timeline'


export interface ClipEditorResult {
  note: string
  start: number
  duration: number
}

interface ClipEditorProps {
  fileUri: string
  fileDuration: number
  title: string
  ownerId: string
  initialStart: number
  initialEnd: number
  initialNote: string
  onCancel: () => void
  onSave: (result: ClipEditorResult) => void
}

export default function ClipEditor({
  fileUri, fileDuration, title, ownerId,
  initialStart, initialEnd, initialNote,
  onCancel, onSave,
}: ClipEditorProps) {
  const { playback, settings, play, pause, seek, updateSettings } = useStore()

  const [note, setNote] = useState(initialNote)
  const [selectionStart, setSelectionStart] = useState(initialStart)
  const [selectionEnd, setSelectionEnd] = useState(initialEnd)

  // Bounds follow playhead: while linked, playhead movement (scrub or
  // playback) pushes the selection anchors — listen and delimit in one go.
  // The toggle state is a remembered preference (settings row).
  const linked = settings.clip_editor_linked
  const toggleLinked = () => {
    updateSettings({ ...settings, clip_editor_linked: !linked })
  }

  // Local state - the position this editor remembers
  const [ownPosition, setOwnPosition] = useState(initialStart)

  // Check ownership and file state from global playback
  const isFileLoaded = playback.uri === fileUri
  const isOwner = playback.ownerId === ownerId
  const isPlaying = isOwner && playback.status === 'playing'
  const isLoading = isOwner && playback.status === 'loading'

  // Stop playback when dismissed (only if we still own it)
  useEffect(() => {
    return () => {
      if (useStore.getState().playback.ownerId === ownerId) pause()
    }
  }, [pause, ownerId])

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
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{`${formatTime(selectionEnd - selectionStart)} (at ${formatTime(selectionStart)})`}</Text>
      </View>

      <Timeline
        duration={fileDuration}
        position={ownPosition}
        onSeek={handleSeek}
        leftColor={Color.TEXT_DISABLED}
        rightColor={Color.TEXT_DISABLED}
        selectionColor={Color.SELECTION}
        selectionStart={selectionStart}
        selectionEnd={selectionEnd}
        onSelectionChange={handleSelectionChange}
        linkedSelection={linked}
        playbackRate={isPlaying ? 1 : 0}
        showTime="hidden"
      />

      <View style={styles.playButtonContainer}>
        <IconButton
          iconName={isPlaying ? 'pause' : 'play'}
          onPress={handlePlayPause}
          size={48}
          active={isPlaying}
          backgroundColor={isLoading ? Color.TEXT_DISABLED : undefined}
        />
        <IconButton
          iconName="link"
          onPress={toggleLinked}
          testID="clip-editor-link-toggle"
          size={36}
          active={linked}
          style={styles.linkButton}
        />
      </View>

      <TextInput
        style={styles.input}
        placeholder="Add note (optional)"
        placeholderTextColor={Color.TEXT_DISABLED}
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
    </View>
  )
}


const styles = StyleSheet.create({
  container: {
    display: 'flex',
    padding: 16,
    gap: 24,
  },
  header: {},
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: Color.TEXT,
  },
  subtitle: {
    fontSize: 14,
    color: Color.TEXT_2,
    marginTop: 4,
  },
  playButtonContainer: {
    alignItems: 'center',
    marginTop: -8
  },
  linkButton: {
    position: 'absolute',
    right: 0,
    top: 6, // vertically centered against the 48px play button
  },
  input: {
    borderWidth: 1,
    borderColor: Color.BORDER,
    borderRadius: Space.BORDER_RADIUS,
    paddingVertical: 12,
    paddingHorizontal: 16,
    color: Color.TEXT,
    fontSize: 16,
    height: 100,
    textAlignVertical: 'top',
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 8,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: Space.BORDER_RADIUS,
    alignItems: 'center',
  },
  secondaryButton: {
    backgroundColor: Color.BACKGROUND_2,
  },
  primaryButton: {
    backgroundColor: Color.PRIMARY,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.TEXT_MUTED,
  },
  primaryButtonText: {
    color: Color.BACKGROUND,
  },
})
