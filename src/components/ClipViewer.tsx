/**
 * ClipViewer
 *
 * Read-only view of a clip with playback timeline, transcription, and note.
 */

import { useRef } from 'react'
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
  const { player, play, pause, seek } = useStore()

  // Stable owner ID for this instance
  const ownerId = useRef(`clip-viewer-${clip.id}`).current

  // Check ownership and file state from global player
  const isFileLoaded = player.file?.uri === clip.source_uri
  const isOwner = player.ownerId === ownerId
  const isPlaying = isOwner && player.status === 'playing'
  const isLoading = isOwner && (player.status === 'loading' || player.status === 'adding')

  const handlePlayPause = async () => {
    try {
      if (isPlaying) {
        await pause()
      } else {
        await play({ fileUri: clip.source_uri, position: clip.start, ownerId })
      }
    } catch (error) {
      console.error('Error toggling playback:', error)
    }
  }

  const handleSeek = (position: number) => {
    if (isFileLoaded) {
      seek({ fileUri: clip.source_uri, position })
    }
  }

  return (
    <>
      <Header
        title={clip.file_title || clip.file_name}
        subtitle={`${formatTime(clip.start)} · ${formatTime(clip.duration)}`}
        noBorder
      />

      {isFileLoaded
        ? <Timeline
            duration={player.duration}
            position={player.position}
            onSeek={handleSeek}
            leftColor={Color.GRAY}
            rightColor={Color.PRIMARY}
            showTime="hidden"
          />
        : <View style={styles.timelinePlaceholder} />
      }

      <View style={styles.playButtonContainer}>
        <IconButton
          iconName={isPlaying ? 'pause' : 'play'}
          onPress={handlePlayPause}
          size={48}
          backgroundColor={isLoading ? Color.GRAY : Color.PRIMARY}
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
          style={[styles.button, styles.primaryButton]}
          onPress={onEdit}
        >
          <Text style={[styles.buttonText, styles.primaryButtonText]}>Edit</Text>
        </TouchableOpacity>
      </View>
    </>
  )
}


const styles = StyleSheet.create({
  timelinePlaceholder: {
    height: 80,
    marginHorizontal: 20,
    backgroundColor: Color.GRAY_LIGHTER,
    borderRadius: 8,
  },
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
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.GRAY_DARKER,
  },
  primaryButtonText: {
    color: Color.WHITE,
  },
})
