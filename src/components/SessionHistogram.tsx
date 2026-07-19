import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useState, useMemo } from 'react'
import ActionMenu from './shared/ActionMenu'
import { Color, Space } from '../theme'
import type { SessionWithBook } from '../services'

type Span = 'day' | 'week' | 'month' | 'year'

const BAR_COUNT = 10
const BAR_AREA_HEIGHT = 96
const VALUE_LABEL_SPACE = 16
const MAX_BAR_HEIGHT = BAR_AREA_HEIGHT - VALUE_LABEL_SPACE
const MIN_BAR_HEIGHT = 2

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th']

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

function formatBucketLabel(start: number, span: Span): string {
  const d = new Date(start)
  if (span === 'day')   return DAYS[d.getDay()]
  if (span === 'month') return MONTHS[d.getMonth()]
  if (span === 'year')  return String(d.getFullYear())
  // Weeks are labeled by their end-point: a week ending Feb 3rd is "1st"
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return ORDINALS[Math.ceil(end.getDate() / 7) - 1]
}

function formatStartDate(start: number, span: Span): string {
  const d = new Date(start)
  if (span === 'year')  return String(d.getFullYear())
  if (span === 'month') return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
  const dayAndMonth = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  if (d.getFullYear() === new Date().getFullYear()) return dayAndMonth
  return `${dayAndMonth}, ${d.getFullYear()}`
}

function getBucketStart(date: Date, span: Span): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)

  if (span === 'day') {
    return d.getTime()
  }
  if (span === 'week') {
    const day = d.getDay()
    d.setDate(d.getDate() - ((day + 6) % 7))
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

interface Bucket {
  start: number
  value: number
}

function computeBuckets(sessions: SessionWithBook[], span: Span): Bucket[] {
  const now = new Date()
  const currentBucketStart = getBucketStart(now, span)

  // Build bucket boundaries (earliest first)
  const boundaries: number[] = []
  for (let i = BAR_COUNT - 1; i >= 0; i--) {
    boundaries.push(getBucketStart(subtractSpans(new Date(currentBucketStart), span, i), span))
  }

  const values = new Array(BAR_COUNT).fill(0)

  for (const session of sessions) {
    const duration = session.ended_at - session.started_at
    if (duration <= 0) continue

    const sessionBucket = getBucketStart(new Date(session.started_at), span)

    for (let i = BAR_COUNT - 1; i >= 0; i--) {
      if (sessionBucket >= boundaries[i]) {
        if (sessionBucket === boundaries[i]) {
          values[i] += duration
        }
        break
      }
    }
  }

  return boundaries.map((start, i) => ({ start, value: values[i] }))
}

interface SessionHistogramProps {
  sessions: SessionWithBook[]
}

export default function SessionHistogram({ sessions }: SessionHistogramProps) {
  const [span, setSpan] = useState<Span>('week')
  const [menuVisible, setMenuVisible] = useState(false)

  const buckets = useMemo(() => computeBuckets(sessions, span), [sessions, span])
  const maxValue = Math.max(...buckets.map((b) => b.value))

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.startDate}>From {formatStartDate(buckets[0].start, span)}</Text>
        <TouchableOpacity
          style={styles.spanBadge}
          onPress={() => setMenuVisible(true)}
          hitSlop={8}
        >
          <Text style={styles.spanBadgeText}>{span.toUpperCase()}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.barArea}>
        {buckets.map((bucket, i) => {
          const isPresent = i === BAR_COUNT - 1
          const barHeight = maxValue > 0
            ? Math.max(MIN_BAR_HEIGHT, (bucket.value / maxValue) * MAX_BAR_HEIGHT)
            : MIN_BAR_HEIGHT

          return (
            <View key={i} style={styles.barColumn}>
              {bucket.value > 0 && (
                <Text style={styles.valueLabel}>{formatCompact(bucket.value)}</Text>
              )}
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
        {buckets.map((bucket, i) => (
          <Text key={i} style={styles.periodLabel}>
            {formatBucketLabel(bucket.start, span)}
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  startDate: {
    fontSize: 12,
    fontWeight: '600',
    color: Color.TEXT_3,
  },
  spanBadge: {
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
    gap: 6,
  },
  barColumn: {
    flex: 1,
    justifyContent: 'flex-end',
    height: '100%',
  },
  valueLabel: {
    fontSize: 9,
    color: Color.TEXT_3,
    textAlign: 'center',
    marginBottom: 3,
  },
  bar: {
    borderRadius: 3,
  },
  labelRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  periodLabel: {
    flex: 1,
    fontSize: 10,
    color: Color.TEXT_3,
    textAlign: 'center',
  },
})
