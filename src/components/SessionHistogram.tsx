import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useState, useMemo } from 'react'
import ActionMenu from './shared/ActionMenu'
import { Color, Space } from '../theme'
import type { SessionWithBook } from '../services'

type Span = 'day' | 'week' | 'month' | 'year'

const BAR_COUNT = 10
const BAR_AREA_HEIGHT = 80
const BAR_TOP_PADDING = 8
const MAX_BAR_HEIGHT = BAR_AREA_HEIGHT - BAR_TOP_PADDING
const MIN_BAR_HEIGHT = 2

const SPAN_LETTERS: Record<Span, string> = {
  day: 'D',
  week: 'W',
  month: 'M',
  year: 'Y',
}

const MENU_ITEMS = [
  { key: 'day',   label: 'Days',   icon: 'today-outline' as const },
  { key: 'week',  label: 'Weeks',  icon: 'calendar-outline' as const },
  { key: 'month', label: 'Months', icon: 'calendar-outline' as const },
  { key: 'year',  label: 'Years',  icon: 'albums-outline' as const },
]

function formatCompact(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60000))
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.round(totalMinutes / 60)
  return `${hours}h`
}

function getBucketStart(date: Date, span: Span): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)

  if (span === 'day') {
    return d.getTime()
  }
  if (span === 'week') {
    const day = d.getDay()
    d.setDate(d.getDate() - day)
    return d.getTime()
  }
  if (span === 'month') {
    d.setDate(1)
    return d.getTime()
  }
  // year
  d.setMonth(0, 1)
  return d.getTime()
}

function subtractSpans(date: Date, span: Span, count: number): Date {
  const d = new Date(date)
  if (span === 'day')   d.setDate(d.getDate() - count)
  if (span === 'week')  d.setDate(d.getDate() - count * 7)
  if (span === 'month') d.setMonth(d.getMonth() - count)
  if (span === 'year')  d.setFullYear(d.getFullYear() - count)
  return d
}

function computeBuckets(sessions: SessionWithBook[], span: Span): number[] {
  const now = new Date()
  const currentBucketStart = getBucketStart(now, span)

  // Build bucket boundaries (earliest first)
  const boundaries: number[] = []
  for (let i = BAR_COUNT - 1; i >= 0; i--) {
    boundaries.push(getBucketStart(subtractSpans(new Date(currentBucketStart), span, i), span))
  }

  const buckets = new Array(BAR_COUNT).fill(0)

  for (const session of sessions) {
    const duration = session.ended_at - session.started_at
    if (duration <= 0) continue

    const sessionBucket = getBucketStart(new Date(session.started_at), span)

    for (let i = BAR_COUNT - 1; i >= 0; i--) {
      if (sessionBucket >= boundaries[i]) {
        if (sessionBucket === boundaries[i]) {
          buckets[i] += duration
        }
        break
      }
    }
  }

  return buckets
}

interface SessionHistogramProps {
  sessions: SessionWithBook[]
}

export default function SessionHistogram({ sessions }: SessionHistogramProps) {
  const [span, setSpan] = useState<Span>('week')
  const [menuVisible, setMenuVisible] = useState(false)

  const buckets = useMemo(() => computeBuckets(sessions, span), [sessions, span])
  const maxValue = Math.max(...buckets)

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.spanBadge}
        onPress={() => setMenuVisible(true)}
        hitSlop={8}
      >
        <Text style={styles.spanBadgeText}>{SPAN_LETTERS[span]}</Text>
      </TouchableOpacity>

      <View style={styles.barArea}>
        {buckets.map((value, i) => {
          const isPresent = i === BAR_COUNT - 1
          const barHeight = maxValue > 0
            ? Math.max(MIN_BAR_HEIGHT, (value / maxValue) * MAX_BAR_HEIGHT)
            : MIN_BAR_HEIGHT

          return (
            <View key={i} style={styles.barColumn}>
              <View
                style={[
                  styles.bar,
                  {
                    height: barHeight,
                    backgroundColor: isPresent ? Color.PRIMARY : Color.TEXT_DISABLED,
                  },
                ]}
              />
            </View>
          )
        })}
      </View>

      <View style={styles.labelRow}>
        {buckets.map((value, i) => (
          <Text key={i} style={styles.barLabel}>
            {value > 0 ? formatCompact(value) : ''}
          </Text>
        ))}
      </View>

      <ActionMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        items={MENU_ITEMS}
        onAction={(key) => {
          setSpan(key as Span)
          setMenuVisible(false)
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Color.BACKGROUND_2,
    borderRadius: Space.BORDER_RADIUS,
    padding: Space.CARD_PADDING,
    marginBottom: 16,
  },
  spanBadge: {
    position: 'absolute',
    top: Space.CARD_PADDING,
    right: Space.CARD_PADDING,
    zIndex: 1,
    backgroundColor: Color.BACKGROUND_3,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  spanBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: Color.TEXT_3,
  },
  barArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: BAR_AREA_HEIGHT,
    paddingTop: BAR_TOP_PADDING,
    gap: 6,
  },
  barColumn: {
    flex: 1,
    justifyContent: 'flex-end',
    height: '100%',
  },
  bar: {
    borderRadius: 3,
  },
  labelRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  barLabel: {
    flex: 1,
    fontSize: 10,
    color: Color.TEXT_3,
    textAlign: 'center',
  },
})
