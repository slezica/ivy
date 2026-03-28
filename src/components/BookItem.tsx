import { View, Text, StyleSheet, TouchableOpacity, Image, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color, Space } from '../theme'
import { formatTime, formatDate } from '../utils'
import type { Book } from '../services'

interface BookItemProps {
  book: Book
  onPress: (book: Book) => void
  onOpenMenu: (bookId: string) => void
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
        <View style={styles.bookMetadata}>
          {book.duration > 0 && (
            <Text style={[styles.bookDuration, isArchived && styles.textArchived]}>
              {formatTime(book.duration)}
            </Text>
          )}
          {!isArchived && book.position > 0 && book.duration > 0 && (
            <Text style={styles.bookProgress}>
              • {Math.round((book.position / book.duration) * 100)}% played
            </Text>
          )}
        </View>

        <Text style={[styles.bookDate, isArchived && styles.textArchived]}>
          {formatDate(book.updated_at)}
        </Text>
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
  bookMetadata: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bookDuration: {
    fontSize: 14,
    color: Color.TEXT_2,
  },
  bookProgress: {
    fontSize: 14,
    color: Color.PRIMARY,
  },
  bookDate: {
    fontSize: 12,
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
