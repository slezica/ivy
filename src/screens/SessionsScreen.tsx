import { View, Text, StyleSheet, FlatList, Image } from 'react-native'
import { useCallback, useMemo } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import EmptyState from '../components/shared/EmptyState'
import { useStore } from '../store'
import { Color } from '../theme'
import { formatTime } from '../utils'
import type { SessionWithBook } from '../services'

export default function SessionsScreen() {
  const router = useRouter()
  const { sessions, fetchSessions } = useStore()

  const sortedSessions = useMemo(
    () => Object.values(sessions).sort((a, b) => b.started_at - a.started_at),
    [sessions]
  )

  useFocusEffect(
    useCallback(() => {
      fetchSessions()
    }, [fetchSessions])
  )

  return (
    <ScreenArea>
      <Header title="History" icon="chevron-back" onIconPress={() => router.back()} />

      {sortedSessions.length > 0 ? (
        <FlatList
          data={sortedSessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <SessionItem session={item} />
          )}
        />
      ) : (
        <EmptyState
          title="No listening history"
          subtitle="Your listening sessions will appear here"
        />
      )}
    </ScreenArea>
  )
}

interface SessionItemProps {
  session: SessionWithBook
}

function SessionItem({ session }: SessionItemProps) {
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
  listContent: {
    padding: 16,
  },
  sessionItem: {
    flexDirection: 'row',
    backgroundColor: Color.GRAY_LIGHTER,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
    gap: 12,
  },
  artwork: {
    width: 48,
    height: 48,
    borderRadius: 6,
  },
  artworkPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 6,
    backgroundColor: Color.GRAY_LIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  artworkPlaceholderIcon: {
    fontSize: 20,
  },
  sessionInfo: {
    flex: 1,
    gap: 2,
  },
  bookName: {
    fontSize: 15,
    fontWeight: '600',
    color: Color.BLACK,
  },
  bookArtist: {
    fontSize: 13,
    color: Color.GRAY_DARK,
  },
  sessionMeta: {
    fontSize: 13,
    color: Color.GRAY_MEDIUM,
    marginTop: 2,
  },
})
