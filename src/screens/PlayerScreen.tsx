import { useState, useEffect, useCallback } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert, ToastAndroid } from 'react-native'
import { useFocusEffect } from 'expo-router'
import Slider from '@react-native-community/slider'
import { Ionicons } from '@expo/vector-icons'

import { Color, Space } from '../theme'
import { useStore } from '../store'
import { Timeline } from '../components/timeline'
import IconButton from '../components/shared/IconButton'
import Dialog from '../components/shared/Dialog'
import ActionMenu from '../components/shared/ActionMenu'
import ScreenArea from '../components/shared/ScreenArea'
import EmptyState from '../components/shared/EmptyState'
import { MAIN_PLAYER_OWNER_ID, formatTime } from '../utils'
import { SKIP_BACKWARD_MS, SKIP_FORWARD_MS } from '../actions/constants'
import { isTestBuild } from '../services'
import type { Book, Chapter } from '../services'

type SleepTimer = { endsAt: number, duration: number } | null

export default function PlayerScreen() {
  const { playback, addClip, play, pause, seek, setSpeed, setSleepTimer, fetchPlaybackState } = useStore()

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
      ToastAndroid.show('Clip added', ToastAndroid.SHORT)
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
              sleepTimer={playback.sleepTimer}
              onPlayPause={handlePlayPause}
              onAddClip={handleAddClip}
              onSeek={handleSeek}
              onSpeedChange={(speed) => setSpeed(ownBook.id, speed)}
              onSleepTimerChange={setSleepTimer}
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
  sleepTimer: SleepTimer
  onPlayPause: () => void
  onAddClip: () => void
  onSeek: (position: number) => void
  onSpeedChange: (speed: number) => void
  onSleepTimerChange: (durationMs: number | null, fadeMs?: number) => void
}

/** Current time, ticking once per second while enabled. */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [enabled])

  return now
}

function Player({
  book, position, isPlaying, sleepTimer,
  onPlayPause, onAddClip, onSeek, onSpeedChange, onSleepTimerChange,
}: PlayerProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [chaptersOpen, setChaptersOpen] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)
  const [sleepOpen, setSleepOpen] = useState(false)
  const chapters = book.chapters ?? []

  const handleChapterPress = (chapter: Chapter) => {
    onSeek(chapter.start_ms)
    setChaptersOpen(false)
  }

  const handleMenuAction = (action: string) => {
    setMenuOpen(false)
    if (action === 'chapters') setChaptersOpen(true)
  }

  const handleSleepTimerChange = (durationMs: number | null, fadeMs?: number) => {
    onSleepTimerChange(durationMs, fadeMs)
    setSleepOpen(false)
  }

  const speedLabel = book.speed === 100 ? '1×' : `${(book.speed / 100).toFixed(1)}×`

  // Sleep button label: minutes remaining, rounded up, floor "1m"
  const now = useNow(sleepTimer !== null)
  const sleepRemaining = sleepTimer ? Math.max(0, sleepTimer.endsAt - now) : null
  const sleepLabel = sleepRemaining !== null
    ? `${Math.max(1, Math.ceil(sleepRemaining / 60_000))}m`
    : null

  return (
    <View style={styles.playerContainer}>
      <TouchableOpacity
        style={styles.menuButton}
        onPress={() => setMenuOpen(true)}
        testID="player-menu-button"
      >
        <Ionicons name="ellipsis-vertical" size={24} color={Color.TEXT} />
      </TouchableOpacity>

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
        leftColor={Color.TEXT_DISABLED}
        rightColor={Color.PRIMARY}
        tapSkip={{ backward: SKIP_BACKWARD_MS, forward: SKIP_FORWARD_MS }}
        playbackRate={isPlaying ? book.speed / 100 : 0}
        showTime='top'
      />

      <View style={styles.playbackControls}>
        <IconButton
          size={72}
          iconName={isPlaying ? 'pause' : 'play'}
          onPress={onPlayPause}
          testID="play-pause-button"
          accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
          active={isPlaying}
        />

        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[styles.circleButton, book.speed !== 100 && styles.circleButtonActive]}
            onPress={() => setSpeedOpen(true)}
            testID="speed-button"
          >
            <Text style={[styles.circleButtonLabel, book.speed !== 100 && styles.circleButtonLabelActive]}>
              {speedLabel}
            </Text>
          </TouchableOpacity>
          <IconButton
            iconName="bookmark"
            onPress={onAddClip}
            testID="add-clip-button"
            size={48}
          />
          <TouchableOpacity
            style={[styles.circleButton, sleepTimer !== null && styles.circleButtonActive]}
            onPress={() => setSleepOpen(true)}
            testID="sleep-timer-button"
          >
            {sleepLabel !== null
              ? <Text style={[styles.circleButtonLabel, styles.circleButtonLabelActive]}>{sleepLabel}</Text>
              : <Ionicons name="moon-outline" size={24} color={Color.PRIMARY} />
            }
          </TouchableOpacity>
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

      <Dialog visible={sleepOpen} onClose={() => setSleepOpen(false)}>
        <SleepTimerControl
          sleepTimer={sleepTimer}
          remaining={sleepRemaining}
          onChange={handleSleepTimerChange}
        />
      </Dialog>

      <ActionMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        onAction={handleMenuAction}
        items={[
          { key: 'chapters', label: 'Show chapters', icon: 'list' },
        ]}
      />

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
        maximumTrackTintColor={Color.TEXT_DISABLED}
        thumbTintColor={Color.PRIMARY}
      />
      <View style={styles.speedLabels}>
        <Text style={styles.speedLabelText}>0.5×</Text>
        <Text style={styles.speedLabelText}>2×</Text>
      </View>
    </View>
  )
}


// =============================================================================
// Sleep Timer
// =============================================================================

// 5s test-build preset (3s + 2s fade): watch a full expiry cycle without
// slowing tests down. debug + maestro builds only (see services/system/build)
const SLEEP_PRESETS: { label: string, durationMs: number, fadeMs?: number }[] = [
  ...(isTestBuild() ? [{ label: '5s', durationMs: 5_000, fadeMs: 2_000 }] : []),
  { label: '10m', durationMs: 10 * 60_000 },
  { label: '30m', durationMs: 30 * 60_000 },
  { label: '60m', durationMs: 60 * 60_000 },
]

interface SleepTimerControlProps {
  sleepTimer: SleepTimer
  remaining: number | null
  onChange: (durationMs: number | null, fadeMs?: number) => void
}

function SleepTimerControl({ sleepTimer, remaining, onChange }: SleepTimerControlProps) {
  return (
    <View style={styles.sleepControl}>
      <Text style={styles.sleepControlTitle}>Sleep timer</Text>
      <Text style={styles.sleepControlValue}>
        {remaining !== null ? formatTime(remaining) : 'Off'}
      </Text>
      <View style={styles.sleepOptions}>
        <SleepOption label="Off" current={sleepTimer === null} onPress={() => onChange(null)} />
        {SLEEP_PRESETS.map(preset => (
          <SleepOption
            key={preset.label}
            label={preset.label}
            current={sleepTimer?.duration === preset.durationMs}
            onPress={() => onChange(preset.durationMs, preset.fadeMs)}
          />
        ))}
      </View>
    </View>
  )
}

interface SleepOptionProps {
  label: string
  current: boolean  // marks the current state; stays tappable (re-tap = reset)
  onPress: () => void
}

function SleepOption({ label, current, onPress }: SleepOptionProps) {
  return (
    <TouchableOpacity
      style={[styles.sleepOption, current && styles.sleepOptionCurrent]}
      onPress={onPress}
    >
      <Text style={[styles.sleepOptionLabel, current && styles.sleepOptionLabelCurrent]}>
        {label}
      </Text>
    </TouchableOpacity>
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
  // Aligned with the three-dot in Header (library/clips): icon 24px at 20px
  // from the right edge, ~18px from the top — stays put across tab switches.
  // Offsets compensate for playerContainer's 12px padding and own 8px padding.
  menuButton: {
    position: 'absolute',
    top: 10,
    right: 0,
    padding: 8,
    zIndex: 1,
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
    color: Color.TEXT,
    lineHeight: 28,
  },
  artist: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    color: Color.TEXT_2,
  },
  playbackControls: {
    alignItems: 'center',
    gap: 24,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 16,
  },
  circleButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    borderColor: Color.PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
  },
  circleButtonActive: {
    backgroundColor: Color.PRIMARY,
    elevation: 4,
  },
  circleButtonLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Color.PRIMARY,
  },
  circleButtonLabelActive: {
    color: Color.PRIMARY_CONTRAST,
  },
  sleepControl: {
    paddingVertical: 24,
    paddingHorizontal: 8,
    alignItems: 'center',
    gap: 8,
  },
  sleepControlTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Color.TEXT,
    marginBottom: 8,
  },
  sleepControlValue: {
    fontSize: 32,
    fontWeight: '700',
    color: Color.PRIMARY,
  },
  sleepOptions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  sleepOption: {
    minWidth: 56,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: Space.BORDER_RADIUS,
    borderWidth: 1.5,
    borderColor: Color.PRIMARY,
    alignItems: 'center',
  },
  sleepOptionCurrent: {
    backgroundColor: Color.PRIMARY,
  },
  sleepOptionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Color.PRIMARY,
  },
  sleepOptionLabelCurrent: {
    color: Color.PRIMARY_CONTRAST,
  },
  speedControl: {
    paddingVertical: 24,
    paddingHorizontal: 8,
    alignItems: 'center',
    gap: 8,
  },
  speedControlTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Color.TEXT,
    marginBottom: 8
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
    paddingHorizontal: 16,
  },
  speedLabelText: {
    fontSize: 12,
    color: Color.TEXT_2,
  },
  chapterList: {
    padding: 16,
    gap: 4,
  },
  chapterListTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Color.TEXT,
    marginBottom: 8,
  },
  chapterItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: Space.BORDER_RADIUS,
  },
  chapterItemCurrent: {
    backgroundColor: Color.BACKGROUND_3,
  },
  chapterTitle: {
    flex: 1,
    fontSize: 15,
    color: Color.TEXT,
  },
  chapterTitleCurrent: {
    fontWeight: '600',
    color: Color.PRIMARY,
  },
  chapterEmpty: {
    fontSize: 15,
    color: Color.TEXT_DISABLED,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  chapterTime: {
    fontSize: 13,
    color: Color.TEXT_2,
    marginLeft: 12,
  },
})
