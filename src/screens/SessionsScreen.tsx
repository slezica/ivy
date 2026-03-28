import { StyleSheet, FlatList } from 'react-native'
import { useCallback, useMemo } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import EmptyState from '../components/shared/EmptyState'
import SessionItem from '../components/SessionItem'
import { useStore } from '../store'
import { Space } from '../theme'

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

const styles = StyleSheet.create({
  listContent: {
    padding: Space.SCREEN_PADDING,
  },
})
