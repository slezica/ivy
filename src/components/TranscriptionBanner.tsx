/**
 * TranscriptionBanner
 *
 * Discrete one-line status message shown on the clips screen whenever the
 * transcription service is in a state the user wouldn't expect (downloading,
 * waiting for Wi-Fi, retrying after a failure, or given up). Tappable when a
 * manual action is the way forward. Appearance is debounced so transient
 * states never flash.
 */

import { useEffect, useState } from 'react'
import { StyleSheet, Text, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useStore } from '../store'
import { Color, Space } from '../theme'
import { bannerContent } from './transcription_banner_content'

// States shorter than this never show a banner
const APPEAR_DELAY_MS = 1000

/** True once `value` has been continuously true for delayMs. */
function useDelayedTrue(value: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false)

  useEffect(() => {
    if (!value) {
      setDelayed(false)
      return
    }

    const timer = setTimeout(() => setDelayed(true), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return delayed
}

export default function TranscriptionBanner() {
  const enabled = useStore(s => s.settings.transcription_enabled)
  const status = useStore(s => s.transcription.status)
  const downloadProgress = useStore(s => s.transcription.downloadProgress)
  const error = useStore(s => s.transcription.error)
  const retryAt = useStore(s => s.transcription.retryAt)
  const startTranscription = useStore(s => s.startTranscription)

  // Tick once per second while counting down to an automatic retry
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (retryAt == null) return

    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [retryAt])

  const content = bannerContent({ enabled, status, downloadProgress, error, retryAt }, now)
  const visible = useDelayedTrue(content !== null, APPEAR_DELAY_MS)

  if (!visible || !content) {
    return null
  }

  return (
    <TouchableOpacity
      testID="transcription-banner"
      style={styles.banner}
      disabled={content.action === null}
      onPress={() => startTranscription(content.action === 'download' ? { ignoreMetered: true } : undefined)}
    >
      <Ionicons name="warning" size={18} color={Color.SECONDARY} style={styles.icon} />
      <Text style={styles.text}>{content.message}</Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: Space.SCREEN_PADDING,
    marginHorizontal: Space.SCREEN_PADDING,
    paddingHorizontal: Space.CARD_PADDING,
    paddingVertical: Space.CARD_PADDING,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 209, 102, 0.08)',  // Color.SECONDARY wash
  },
  icon: {
    marginRight: 8,
    marginTop: 2,
  },
  text: {
    flex: 1,
    fontSize: 14,
    color: Color.TEXT_2,
    lineHeight: Space.PARAGRAPH_LINE_HEIGHT,
  },
})
