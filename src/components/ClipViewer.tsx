/**
 * ClipViewer
 *
 * Read-only view of a clip with playback timeline, transcription, and note.
 */

import { useState, useEffect, useRef } from 'react'
import { View, Text, Pressable, TouchableOpacity, StyleSheet } from 'react-native'

import { useStore } from '../store'
import { Color, Space } from '../theme'
import { formatTime } from '../utils'
import Header from './shared/Header'
import IconButton from './shared/IconButton'
import { Timeline } from './timeline'
import { copyText } from '../services'
import type { ClipWithFile } from '../services'


interface ClipViewerProps {
  clip: ClipWithFile
  onClose: () => void
  onEdit: () => void
}

export default function ClipViewer({ clip, onClose, onEdit }: ClipViewerProps) {
  const playback = useStore(s => s.playback)
  const play = useStore(s => s.play)
  const pause = useStore(s => s.pause)
  const seek = useStore(s => s.seek)
  const releasePlayback = useStore(s => s.releasePlayback)

  // The viewer always plays the clip's own audio: the timeline is the clip,
  // and playback ends where the clip does. The source book only matters for
  // editing (re-slicing needs it) — see docs/2026-09-06-clip-viewer-own-audio.md
  const canEdit = clip.file_uri !== null && clip.file_duration !== null

  // Local state - the position this viewer remembers
  const [ownPosition, setOwnPosition] = useState(0)

  // Expandable text sections
  const [transcriptionExpanded, setTranscriptionExpanded] = useState(false)
  const [noteExpanded, setNoteExpanded] = useState(false)

  // Stable owner ID for this instance
  const ownerId = useRef(`clip-viewer-${clip.id}`).current

  // Check ownership and file state from global playback
  const isFileLoaded = playback.uri === clip.uri
  const isOwner = playback.ownerId === ownerId
  const isPlaying = isOwner && playback.status === 'playing'
  const isLoading = isOwner && playback.status === 'loading'

  // Release playback when dismissed: pause and return ownership to the main
  // player (the action no-ops if we no longer own playback)
  useEffect(() => {
    return () => { releasePlayback(ownerId) }
  }, [releasePlayback, ownerId])

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
        // Claim ownership and play from our remembered position (a playhead
        // parked at the end restarts from the top — the play action's rule)
        await play({ fileUri: clip.uri, position: ownPosition, ownerId })
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
      seek({ fileUri: clip.uri, position })
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{clip.file_title || clip.file_name || clip.source_title || 'Unknown book'}</Text>
        <Text style={styles.subtitle}>{`${formatTime(clip.duration)} (at ${formatTime(clip.start)})`}</Text>
      </View>

      <Timeline
        duration={clip.duration}
        position={ownPosition}
        onSeek={handleSeek}
        leftColor={Color.TEXT_DISABLED}
        rightColor={Color.PRIMARY}
        playbackRate={isPlaying ? 1 : 0}
        shapeSeed={clip.id}
        showTime="top"
      />

      <View style={styles.playButtonContainer}>
        <IconButton
          iconName={isPlaying ? 'pause' : 'play'}
          onPress={handlePlayPause}
          size={48}
          backgroundColor={isLoading ? Color.TEXT_DISABLED : undefined}
          testID={isPlaying ? 'clip-viewer-pause-button' : 'clip-viewer-play-button'}
        />
      </View>

      {clip.transcription && (
        <Pressable
          style={styles.infoSection}
          onPress={() => setTranscriptionExpanded(e => !e)}
          onLongPress={() => copyText(clip.transcription!)}
        >
          <Text style={styles.infoLabel}>Transcription</Text>
          <Text style={styles.infoText} numberOfLines={transcriptionExpanded ? undefined : 4}>{clip.transcription}</Text>
        </Pressable>
      )}

      {clip.note && (
        <Pressable
          style={styles.infoSection}
          onPress={() => setNoteExpanded(e => !e)}
          onLongPress={() => copyText(clip.note!)}
        >
          <Text style={styles.infoLabel}>Note</Text>
          <Text style={styles.infoText} numberOfLines={noteExpanded ? undefined : 4}>{clip.note}</Text>
        </Pressable>
      )}

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={onClose}
        >
          <Text style={styles.buttonText}>Close</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, canEdit ? styles.primaryButton : styles.disabledButton]}
          onPress={onEdit}
          disabled={!canEdit}
        >
          <Text style={[styles.buttonText, canEdit ? styles.primaryButtonText : styles.disabledButtonText]}>
            Edit
          </Text>
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
  },
  infoSection: {},
  infoLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Color.TEXT_2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  infoText: {
    fontSize: 15,
    color: Color.TEXT_MUTED,
    lineHeight: Space.PARAGRAPH_LINE_HEIGHT,
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
  disabledButton: {
    backgroundColor: Color.BACKGROUND_3,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.TEXT_MUTED,
  },
  primaryButtonText: {
    color: Color.BACKGROUND,
  },
  disabledButtonText: {
    color: Color.TEXT_DISABLED,
  },
})
