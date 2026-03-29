import { View, Text, StyleSheet, TouchableOpacity, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color, Space } from '../theme'
import { formatTime, formatDuration } from '../utils'
import type { ClipWithFile } from '../services'

interface ClipItemProps {
  clip: ClipWithFile
  isPending: boolean
  onView: (clipId: string) => void
  onOpenMenu: (clipId: string) => void
}

export default function ClipItem({ clip, isPending, onView, onOpenMenu }: ClipItemProps) {
  return (
    <TouchableOpacity
      style={styles.clipItem}
      onPress={() => onView(clip.id)}
      activeOpacity={0.7}
      testID="clip-card"
    >
      <View style={styles.clipContent}>
        <Text style={styles.clipFileLabel} numberOfLines={1}>
          {clip.file_title || clip.file_name}
        </Text>

        <View style={styles.clipHeader}>
          <Text style={styles.clipTime}>{formatDuration(clip.duration, { seconds: true })}</Text>
          {clip.duration > 0 && (
            <Text style={styles.clipDuration}>
              (at {formatTime(clip.start)})
            </Text>
          )}
        </View>
        {isPending ? (
          <Text style={styles.clipTranscription} numberOfLines={2}>
            Transcribing...
          </Text>
        ) : null}
        {clip.transcription ? (
          <Text style={styles.clipTranscription} numberOfLines={2}>
            &ldquo;{clip.transcription} ...&rdquo;
          </Text>
        ) : null}
      </View>

      <Pressable
        style={styles.menuButton}
        onPress={() => onOpenMenu(clip.id)}
        hitSlop={8}
        testID="clip-menu-button"
      >
        <Ionicons name="ellipsis-vertical" size={20} color={Color.TEXT_2} />
      </Pressable>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  clipItem: {
    flexDirection: 'row',
    backgroundColor: Color.BACKGROUND_2,
    borderRadius: Space.BORDER_RADIUS,
    padding: Space.CARD_PADDING,
    marginBottom: Space.CARD_LIST_GAP,
  },
  clipContent: {
    flex: 1,
    gap: Space.CARD_LINE_GAP,
  },
  clipFileLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Color.PRIMARY,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  clipHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  clipTime: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.TEXT_2,
  },
  clipDuration: {
    fontSize: 14,
    color: Color.TEXT_2,
  },
  clipTranscription: {
    fontSize: 14,
    fontStyle: 'italic',
    lineHeight: Space.PARAGRAPH_LINE_HEIGHT,
    color: Color.TEXT,
    marginTop: 4,
  },
  menuButton: {
    padding: 0,
    justifyContent: 'flex-start',
  },
})
