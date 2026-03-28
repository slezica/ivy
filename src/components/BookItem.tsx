import { View, Text, StyleSheet, TouchableOpacity, Image, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color, Space } from '../theme'
import { formatDuration } from '../utils'
import type { Book } from '../services'

interface BookItemProps {
  book: Book
  onPress: (book: Book) => void
  onOpenMenu: (bookId: string) => void
}

function getRemainingLabel(book: Book): string {
  const remaining = book.duration - book.position
  const percentLeft = remaining / book.duration

  if (remaining < 60_000 && percentLeft < 0.01) return 'Finished'
  if (book.position === 0) return formatDuration(book.duration)
  return `${formatDuration(remaining)} left`
}

export default function BookItem({ book, onPress, onOpenMenu }: BookItemProps) {
  const isArchived = book.uri === null

  return (
    <TouchableOpacity
      style={[styles.bookItem, isArchived && styles.bookItemArchived]}
      onPress={() => onPress(book)}
      activeOpacity={0.7}
    >
      {book.artwork ? (
        <Image
          source={{ uri: book.artwork }}
          style={[styles.artwork, isArchived && styles.artworkArchived]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.artworkPlaceholder, isArchived && styles.artworkArchived]}>
          <Text style={styles.artworkPlaceholderIcon}>🎵</Text>
        </View>
      )}

      <View style={styles.bookInfo}>
        <Text style={[styles.bookName, isArchived && styles.textArchived]} numberOfLines={1}>
          {book.title || book.name}
        </Text>
        {book.artist && (
          <Text style={[styles.bookArtist, isArchived && styles.textArchived]} numberOfLines={1}>
            {book.artist}
          </Text>
        )}
        {book.duration > 0 && (
          <Text style={[styles.bookDuration, isArchived && styles.textArchived]}>
            {getRemainingLabel(book)}
          </Text>
        )}
      </View>

      <Pressable
        style={styles.menuButton}
        onPress={() => onOpenMenu(book.id)}
        hitSlop={8}
      >
        <Ionicons name="ellipsis-vertical" size={20} color={Color.TEXT_2} />
      </Pressable>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  bookItem: {
    flexDirection: 'row',
    backgroundColor: Color.BACKGROUND_2,
    borderRadius: Space.BORDER_RADIUS,
    padding: Space.CARD_PADDING,
    marginBottom: Space.CARD_LIST_GAP,
    gap: 12,
  },
  bookItemArchived: {
    opacity: 0.6,
  },
  artwork: {
    width: 65,
    height: 65,
    borderRadius: Space.BORDER_RADIUS,
  },
  artworkPlaceholder: {
    width: 65,
    height: 65,
    borderRadius: Space.BORDER_RADIUS,
    backgroundColor: Color.BACKGROUND_3,
    justifyContent: 'center',
    alignItems: 'center',
  },
  artworkPlaceholderIcon: {
    fontSize: 24,
  },
  artworkArchived: {
    opacity: 0.7,
  },
  bookInfo: {
    flex: 1,
    gap: Space.CARD_LINE_GAP,
  },
  bookName: {
    fontSize: 16,
    fontWeight: '600',
    color: Color.TEXT,
  },
  bookArtist: {
    fontSize: 14,
    color: Color.TEXT_2,
    fontWeight: '500',
  },
  bookDuration: {
    fontSize: 14,
    color: Color.TEXT_2,
  },
  textArchived: {
    color: Color.TEXT_DISABLED,
  },
  menuButton: {
    padding: 0,
    justifyContent: 'flex-start',
  },
})
