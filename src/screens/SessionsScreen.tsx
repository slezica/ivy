import { StyleSheet, FlatList, TouchableOpacity } from 'react-native'
import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import InputHeader from '../components/shared/InputHeader'
import EmptyState from '../components/shared/EmptyState'
import SessionItem from '../components/SessionItem'
import SessionHistogram from '../components/SessionHistogram'
import { useStore } from '../store'
import { Color, Space } from '../theme'

export default function SessionsScreen() {
  const router = useRouter()
  const { sessions, fetchSessions } = useStore()

  const [isSearching, setIsSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const sortedSessions = useMemo(() =>
    Object.values(sessions)
      .filter((session) => {
        if (!searchQuery) return true
        const query = searchQuery.toLowerCase()
        return (
          session.book_title?.toLowerCase().includes(query) ||
          session.book_name?.toLowerCase().includes(query) ||
          session.book_artist?.toLowerCase().includes(query)
        )
      })
      .sort((a, b) => b.started_at - a.started_at),
    [sessions, searchQuery]
  )

  useFocusEffect(
    useCallback(() => {
      fetchSessions()
    }, [fetchSessions])
  )

  const handleOpenSearch = () => {
    setIsSearching(true)
  }

  const handleCloseSearch = () => {
    setIsSearching(false)
    setSearchQuery('')
  }

  return (
    <ScreenArea>
      {isSearching
        ? <InputHeader
            value={searchQuery}
            onChangeText={setSearchQuery}
            onClose={handleCloseSearch}
          />

        : <Header title="History" icon="chevron-back" onIconPress={() => router.back()}>
            <TouchableOpacity onPress={handleOpenSearch}>
              <Ionicons name="search" size={24} color={Color.TEXT} />
            </TouchableOpacity>
          </Header>
      }

      {sortedSessions.length > 0
        ? <FlatList
            data={sortedSessions}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={<SessionHistogram sessions={sortedSessions} />}
            renderItem={({ item }) => (
              <SessionItem session={item} />
            )}
          /> :

       searchQuery.length > 0
        ? <EmptyState title="No sessions found" subtitle="Nothing matches your search" />
        : <EmptyState
            title="No listening history"
            subtitle="Your listening sessions will appear here"
          />
      }
    </ScreenArea>
  )
}

const styles = StyleSheet.create({
  listContent: {
    padding: Space.SCREEN_PADDING,
  },
})
