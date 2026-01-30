/**
 * ClipViewer
 *
 * Read-only view of a clip with playback timeline, transcription, and note.
 */

import { useState, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'

import { useStore } from '../store'
import { Color } from '../theme'
import { formatTime } from '../utils'
import Header from './shared/Header'
import IconButton from './shared/IconButton'
import { Timeline } from './timeline'
import type { ClipWithFile } from '../services'


interface ClipViewerProps {
  clip: ClipWithFile
  onClose: () => void
  onEdit: () => void
}

export default function ClipViewer({ clip, onClose, onEdit }: ClipViewerProps) {
  const { playback, play, pause, seek } = useStore()

  // Determine playback source: use source file if available, otherwise clip's own file
  const hasSourceFile = clip.file_uri !== null
  const playbackUri = hasSourceFile ? clip.file_uri! : clip.uri
  const playbackDuration = hasSourceFile ? clip.file_duration : clip.duration
  const initialPosition = hasSourceFile ? clip.start : 0

  // Local state - the position this viewer remembers
  const [ownPosition, setOwnPosition] = useState(initialPosition)

  // Stable owner ID for this instance
  const ownerId = useRef(`clip-viewer-${clip.id}`).current

  // Check ownership and file state from global playback
  const isFileLoaded = playback.uri === playbackUri
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

  const handlePlayPause = async () => {
    try {
      if (isPlaying) {
        await pause()
      } else {
        // Claim ownership and play from our remembered position
        await play({ fileUri: playbackUri, position: ownPosition, ownerId })
      }
    } catch (error) {
      console.error('Error toggling playback:', error)
    }
  }

  const handleSeek = (position: number) => {
    // Always update local position
    setOwnPosition(position)

    // Only affect playback if we're the owner and file is loaded
    if (isOwner && isFileLoaded) {
      seek({ fileUri: playbackUri, position })
    }
  }

  return (
    <>
      <Header
        title={clip.file_title || clip.file_name}
        subtitle={`${formatTime(clip.start)} · ${formatTime(clip.duration)}`}
        noBorder
      />

      <Timeline
        duration={playbackDuration}
        position={ownPosition}
        onSeek={handleSeek}
        leftColor={Color.PRIMARY}
        rightColor={Color.PRIMARY}
        selectionColor={Color.SELECTION}
        selectionStart={hasSourceFile ? clip.start : 0}
        selectionEnd={hasSourceFile ? clip.start + clip.duration : clip.duration}
        showTime="hidden"
      />

      <View style={styles.playButtonContainer}>
        <IconButton
          iconName={isPlaying ? 'pause' : 'play'}
          onPress={handlePlayPause}
          size={48}
          backgroundColor={isLoading ? Color.GRAY : Color.PRIMARY}
          testID="clip-viewer-play-button"
        />
      </View>

      {clip.transcription && (
        <View style={styles.infoSection}>
          <Text style={styles.infoLabel}>Transcription</Text>
          <Text style={styles.infoText}>&ldquo;{clip.transcription}&rdquo;</Text>
        </View>
      )}

      {clip.note && (
        <View style={styles.infoSection}>
          <Text style={styles.infoLabel}>Note</Text>
          <Text style={styles.infoText}>{clip.note}</Text>
        </View>
      )}

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={onClose}
        >
          <Text style={styles.buttonText}>Close</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, hasSourceFile ? styles.primaryButton : styles.disabledButton]}
          onPress={onEdit}
          disabled={!hasSourceFile}
        >
          <Text style={[styles.buttonText, hasSourceFile ? styles.primaryButtonText : styles.disabledButtonText]}>
            Edit
          </Text>
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
  infoSection: {
    marginHorizontal: 20,
    marginBottom: 16,
  },
  infoLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Color.GRAY_DARK,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  infoText: {
    fontSize: 15,
    color: Color.GRAY_DARKER,
    lineHeight: 22,
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
  disabledButton: {
    backgroundColor: Color.GRAY_LIGHT,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.GRAY_DARKER,
  },
  primaryButtonText: {
    color: Color.WHITE,
  },
  disabledButtonText: {
    color: Color.GRAY,
  },
})
