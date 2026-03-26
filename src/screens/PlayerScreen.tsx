import { useState, useEffect, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import { useFocusEffect } from 'expo-router'
import Slider from '@react-native-community/slider'

import { Color } from '../theme'
import { useStore } from '../store'
import { Timeline } from '../components/timeline'
import IconButton from '../components/shared/IconButton'
import Dialog from '../components/shared/Dialog'
import ScreenArea from '../components/shared/ScreenArea'
import EmptyState from '../components/shared/EmptyState'
import { MAIN_PLAYER_OWNER_ID, formatTime } from '../utils'
import type { Book, Chapter } from '../services'

export default function PlayerScreen() {
  const { playback, addClip, play, pause, seek, setSpeed, fetchPlaybackState } = useStore()

  // Remember which book we're showing (survives ownership changes)
  const [ownBookId, setOwnBookId] = useState<string | null>(null)
  const [ownPosition, setOwnPosition] = useState(0)

  // Book data always comes fresh from the store
  const ownBook = useStore(state => ownBookId ? state.books[ownBookId] ?? null : null)

  // Ownership check
  const isOwner = playback.ownerId === MAIN_PLAYER_OWNER_ID
  const isFileLoaded = playback.uri === ownBook?.uri

  // Adopt book when playback targets the main player
  useEffect(() => {
    if (isOwner && playback.uri && playback.uri !== ownBook?.uri) {
      // Look up book ID by matching URI
      const books = useStore.getState().books
      const book = Object.values(books).find(b => b.uri === playback.uri)
      if (book) {
        setOwnBookId(book.id)
        setOwnPosition(playback.position)
      }
    }
  }, [isOwner, playback.uri, playback.position, ownBook?.uri])

  // Sync position from playback when we own playback
  useEffect(() => {
    if (isOwner && isFileLoaded) {
      setOwnPosition(playback.position)
    }
  }, [isOwner, isFileLoaded, playback.position])

  // Sync position immediately when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      fetchPlaybackState()
    }, [fetchPlaybackState])
  )

  const handleAddClip = async () => {
    if (!ownBook) return

    try {
      await addClip(ownBook.id, ownPosition)
    } catch (error) {
      console.error('Error adding clip:', error)
      Alert.alert('Error', 'Failed to add clip')
    }
  }

  const handlePlayPause = async () => {
    if (!ownBook?.uri) return

    try {
      if (isOwner && playback.status === 'playing') {
        await pause()
      } else {
        // Claim ownership and play from our remembered position
        await play({
          fileUri: ownBook.uri,
          position: ownPosition,
          ownerId: MAIN_PLAYER_OWNER_ID,
        })
      }
    } catch (error) {
      console.error('Error toggling playback:', error)
      Alert.alert('Error', 'Failed to toggle playback')
    }
  }

  const handleSeek = useCallback((position: number) => {
    // Always update local position
    setOwnPosition(position)

    // Only affect playback if we're the owner and file is loaded
    if (isOwner && isFileLoaded && ownBook?.uri) {
      seek({ fileUri: ownBook.uri, position })
    }
  }, [isOwner, isFileLoaded, ownBook, seek])

  // Show play button unless we're owner AND playing
  const isPlaying = isOwner && playback.status === 'playing'

  return (
    <ScreenArea>
      <View style={styles.content}>
        {ownBook
          ? <Player
              book={ownBook}
              position={ownPosition}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              onAddClip={handleAddClip}
              onSeek={handleSeek}
              onSpeedChange={(speed) => setSpeed(ownBook.id, speed)}
            />
          : <EmptyState title="Not playing" subtitle="Select a book from your library" />
        }
      </View>
    </ScreenArea>
  )
}

interface PlayerProps {
  book: Book
  position: number
  isPlaying: boolean
  onPlayPause: () => void
  onAddClip: () => void
  onSeek: (position: number) => void
  onSpeedChange: (speed: number) => void
}

function Player({ book, position, isPlaying, onPlayPause, onAddClip, onSeek, onSpeedChange }: PlayerProps) {
  const [chaptersOpen, setChaptersOpen] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)
  const chapters = book.chapters ?? []

  const handleChapterPress = (chapter: Chapter) => {
    onSeek(chapter.start_ms)
    setChaptersOpen(false)
  }

  const speedLabel = book.speed === 100 ? '1×' : `${(book.speed / 100).toFixed(1)}×`

  return (
    <View style={styles.playerContainer}>
      <View style={styles.spacerTop} />

      <View style={styles.bookInfo}>
        <Text style={styles.title} numberOfLines={2}>
          {book.title || book.name}
        </Text>
        {book.artist && (
          <Text style={styles.artist} numberOfLines={1}>
            {book.artist}
          </Text>
        )}
      </View>

      <Timeline
        duration={book.duration}
        position={position}
        onSeek={onSeek}
        leftColor={Color.GRAY}
        rightColor={Color.PRIMARY}
        showTime='top'
      />

      <View style={styles.playbackControls}>
        <IconButton
          size={72}
          iconName={isPlaying ? 'pause' : 'play'}
          onPress={onPlayPause}
          testID="play-pause-button"
        />

        <View style={styles.actionButtons}>
          <IconButton
            iconName="bookmark"
            onPress={onAddClip}
            testID="add-clip-button"
            size={48}
          />
          <TouchableOpacity
            style={styles.speedButton}
            onPress={() => setSpeedOpen(true)}
            testID="speed-button"
          >
            <Text style={styles.speedButtonLabel}>{speedLabel}</Text>
          </TouchableOpacity>
          <IconButton
            iconName="list"
            onPress={() => setChaptersOpen(true)}
            testID="chapters-button"
            size={48}
          />
        </View>
      </View>

      <Dialog visible={chaptersOpen} onClose={() => setChaptersOpen(false)}>
        <ChapterList
          chapters={chapters}
          position={position}
          onPress={handleChapterPress}
        />
      </Dialog>

      <Dialog visible={speedOpen} onClose={() => setSpeedOpen(false)}>
        <SpeedControl
          speed={book.speed}
          onChange={onSpeedChange}
        />
      </Dialog>

    <View style={styles.spacerBottom} />
  </View>
  )
}


// =============================================================================
// Speed Control
// =============================================================================

interface SpeedControlProps {
  speed: number
  onChange: (speed: number) => void
}

function SpeedControl({ speed, onChange }: SpeedControlProps) {
  const [localSpeed, setLocalSpeed] = useState(speed)
  const displaySpeed = localSpeed / 100
  const label = localSpeed === 100 ? '1×' : `${displaySpeed.toFixed(1)}×`

  return (
    <View style={styles.speedControl}>
      <Text style={styles.speedControlTitle}>Playback Speed</Text>
      <Text style={styles.speedControlValue}>{label}</Text>
      <Slider
        style={styles.speedSlider}
        minimumValue={50}
        maximumValue={200}
        step={10}
        value={speed}
        onValueChange={(value) => setLocalSpeed(Math.round(value))}
        onSlidingComplete={(value) => onChange(Math.round(value))}
        minimumTrackTintColor={Color.PRIMARY}
        maximumTrackTintColor={Color.GRAY}
        thumbTintColor={Color.PRIMARY}
      />
      <View style={styles.speedLabels}>
        <Text style={styles.speedLabelText}>0.5×</Text>
        <Text style={styles.speedLabelText}>1×</Text>
        <Text style={styles.speedLabelText}>2×</Text>
      </View>
    </View>
  )
}


// =============================================================================
// Chapter List
// =============================================================================

interface ChapterListProps {
  chapters: Chapter[]
  position: number
  onPress: (chapter: Chapter) => void
}

function ChapterList({ chapters, position, onPress }: ChapterListProps) {
  return (
    <View style={styles.chapterList}>
      <Text style={styles.chapterListTitle}>Chapters</Text>
      {chapters.length === 0 && (
        <Text style={styles.chapterEmpty}>No chapters in this file</Text>
      )}
      {chapters.map((chapter, index) => {
        const isCurrent = position >= chapter.start_ms && position < chapter.end_ms

        return (
          <TouchableOpacity
            key={index}
            style={[styles.chapterItem, isCurrent && styles.chapterItemCurrent]}
            onPress={() => onPress(chapter)}
          >
            <Text style={[styles.chapterTitle, isCurrent && styles.chapterTitleCurrent]} numberOfLines={1}>
              {chapter.title || `Chapter ${index + 1}`}
            </Text>
            <Text style={styles.chapterTime}>
              {formatTime(chapter.start_ms)}
            </Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  playerContainer: {
    flex: 1,
    gap: 48,
    paddingHorizontal: 12
  },
  spacerTop: {
    flex: 8,
  },
  spacerBottom: {
    flex: 2,
  },
  bookInfo: {
    paddingHorizontal: 32,
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    color: Color.BLACK,
    lineHeight: 28,
  },
  artist: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    color: Color.GRAY_DARK,
  },
  playbackControls: {
    alignItems: 'center',
    gap: 24,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 16,
  },
  speedButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Color.PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Color.PRIMARY,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 4,
  },
  speedButtonLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Color.BLACK,
  },
  speedControl: {
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  speedControlTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Color.BLACK,
  },
  speedControlValue: {
    fontSize: 32,
    fontWeight: '700',
    color: Color.PRIMARY,
  },
  speedSlider: {
    width: '100%',
    height: 40,
  },
  speedLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 4,
  },
  speedLabelText: {
    fontSize: 12,
    color: Color.GRAY_DARK,
  },
  chapterList: {
    padding: 16,
    gap: 4,
  },
  chapterListTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Color.BLACK,
    marginBottom: 8,
  },
  chapterItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  chapterItemCurrent: {
    backgroundColor: Color.GRAY_LIGHT,
  },
  chapterTitle: {
    flex: 1,
    fontSize: 15,
    color: Color.BLACK,
  },
  chapterTitleCurrent: {
    fontWeight: '600',
    color: Color.PRIMARY,
  },
  chapterEmpty: {
    fontSize: 15,
    color: Color.GRAY,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  chapterTime: {
    fontSize: 13,
    color: Color.GRAY_DARK,
    marginLeft: 12,
  },
})
