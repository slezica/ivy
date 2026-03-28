import { View, Text, StyleSheet, Image } from 'react-native'
import { Color, Space } from '../theme'
import { formatTime } from '../utils'
import type { SessionWithBook } from '../services'

interface SessionItemProps {
  session: SessionWithBook
}

export default function SessionItem({ session }: SessionItemProps) {
  const duration = session.ended_at - session.started_at
  const date = new Date(session.started_at)
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  return (
    <View style={styles.sessionItem}>
      {session.book_artwork ? (
        <Image
          source={{ uri: session.book_artwork }}
          style={styles.artwork}
          resizeMode="cover"
        />
      ) : (
        <View style={styles.artworkPlaceholder}>
          <Text style={styles.artworkPlaceholderIcon}>🎵</Text>
        </View>
      )}

      <View style={styles.sessionInfo}>
        <Text style={styles.bookName} numberOfLines={1}>
          {session.book_title || session.book_name}
        </Text>

        {session.book_artist && (
          <Text style={styles.bookArtist} numberOfLines={1}>
            {session.book_artist}
          </Text>
        )}

        <Text style={styles.sessionMeta}>
          {dateStr} at {timeStr} · {formatTime(duration)}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  sessionItem: {
    flexDirection: 'row',
    backgroundColor: Color.BACKGROUND_2,
    borderRadius: Space.BORDER_RADIUS,
    padding: Space.CARD_PADDING,
    marginBottom: 12,
    gap: 12,
  },
  artwork: {
    width: 48,
    height: 48,
    borderRadius: Space.BORDER_RADIUS,
  },
  artworkPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: Space.BORDER_RADIUS,
    backgroundColor: Color.BACKGROUND_3,
    justifyContent: 'center',
    alignItems: 'center',
  },
  artworkPlaceholderIcon: {
    fontSize: 20,
  },
  sessionInfo: {
    flex: 1,
    gap: Space.CARD_LINE_GAP,
  },
  bookName: {
    fontSize: 15,
    fontWeight: '600',
    color: Color.TEXT,
  },
  bookArtist: {
    fontSize: 13,
    color: Color.TEXT_2,
  },
  sessionMeta: {
    fontSize: 13,
    color: Color.TEXT_3,
  },
})
