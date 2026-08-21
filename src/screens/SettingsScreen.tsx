import { View, Text, StyleSheet, Switch, TouchableOpacity } from 'react-native'
import { useCallback, useEffect, useState } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import { Color, Space } from '../theme'
import { useStore } from '../store'
import { downloadingMessage, failureLabel, retryingMessage } from '../components/transcription_banner_content'

export default function SettingsScreen() {
  const router = useRouter()
  const settings = useStore(s => s.settings)
  const sync = useStore(s => s.sync)
  const transcriptionStatus = useStore(s => s.transcription.status)
  const transcriptionProgress = useStore(s => s.transcription.downloadProgress)
  const transcriptionError = useStore(s => s.transcription.error)
  const transcriptionRetryAt = useStore(s => s.transcription.retryAt)
  const updateSettings = useStore(s => s.updateSettings)
  const syncNow = useStore(s => s.syncNow)
  const fetchSyncState = useStore(s => s.fetchSyncState)
  const startTranscription = useStore(s => s.startTranscription)
  const stopTranscription = useStore(s => s.stopTranscription)

  useFocusEffect(
    useCallback(() => {
      fetchSyncState()
    }, [fetchSyncState])
  )

  // Tick once per second while counting down to an automatic retry
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (transcriptionRetryAt == null) return

    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [transcriptionRetryAt])

  const pendingLabel = sync.pendingCount === 1 ? '1 item pending' : `${sync.pendingCount} items pending`
  const failingLabel = `${sync.failingCount === 1 ? '1 change' : `${sync.failingCount} changes`} failing — will keep retrying`

  function handleSyncToggle(enabled: boolean) {
    updateSettings({ ...settings, sync_enabled: enabled })

    // Unconditional: syncNow is the only path with interactive sign-in, and
    // the first enable must pull remote data even with an empty outbox
    if (enabled) {
      syncNow()
    }
  }

  function handleTranscriptionToggle(enabled: boolean) {
    updateSettings({ ...settings, transcription_enabled: enabled })

    if (enabled) {
      startTranscription()
    } else {
      stopTranscription()
    }
  }

  return (
    <ScreenArea>
      <Header title="Settings" icon="chevron-back" onIconPress={() => router.back()} />

      <View style={styles.content}>
        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Auto-transcribe clips</Text>

          <Switch
            testID="transcription-switch"
            value={settings.transcription_enabled}
            onValueChange={handleTranscriptionToggle}
            trackColor={{ false: Color.TEXT_DISABLED, true: Color.PRIMARY }}
            thumbColor={Color.TEXT}
          />
        </View>

        <View style={styles.settingSecondary}>
          <Text style={transcriptionStatus === 'error' ? styles.errorText : styles.secondaryText}>
            {transcriptionStatus === 'off' && (settings.transcription_enabled ? 'Enabled' : 'Disabled')}
            {transcriptionStatus === 'starting' && (
              transcriptionRetryAt != null
                ? retryingMessage(transcriptionError, transcriptionRetryAt, now)
                : 'Starting...'
            )}
            {transcriptionStatus === 'downloading' && downloadingMessage(transcriptionProgress)}
            {transcriptionStatus === 'on' && 'Enabled'}
            {transcriptionStatus === 'error' && failureLabel(transcriptionError)}
          </Text>

          {transcriptionStatus === 'error' && (
            <>
              <Text style={styles.secondaryText}> · </Text>
              <TouchableOpacity onPress={() => startTranscription()}>
                <Text style={styles.linkText}>Retry</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {transcriptionStatus === 'error' && transcriptionError && (
          <View style={styles.settingSecondary}>
            <Text style={styles.secondaryText} numberOfLines={2}>
              {transcriptionError.message}
            </Text>
          </View>
        )}

        <View style={[styles.settingRow, { marginTop: 24 }]}>
          <Text style={styles.settingLabel}>Sync metadata to Drive</Text>

          <Switch
            testID="sync-switch"
            value={settings.sync_enabled}
            onValueChange={handleSyncToggle}
            trackColor={{ false: Color.TEXT_DISABLED, true: Color.PRIMARY }}
            thumbColor={Color.TEXT}
          />
        </View>

        {!settings.sync_enabled && (
          <View style={styles.settingSecondary}>
            <Text style={styles.secondaryText}>Disabled</Text>
          </View>
        )}

        {settings.sync_enabled && (
          <View style={styles.settingSecondary}>
            <Text style={styles.secondaryText}>
              {sync.pendingCount > 0 ? pendingLabel : sync.lastSyncTime ? 'Up to date' : 'Not synced yet'}
            </Text>

            {sync.error && (
              <>
                <Text style={styles.secondaryText}> · </Text>
                <Text style={styles.errorText}>Failed</Text>
              </>
            )}

            <Text style={styles.secondaryText}> · </Text>

            <TouchableOpacity onPress={syncNow} disabled={sync.isSyncing}>
              <Text style={styles.linkText}>
                {sync.isSyncing ? 'Syncing...' : 'Sync now'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {settings.sync_enabled && sync.failingCount > 0 && (
          <View style={styles.settingSecondary}>
            <Text style={styles.errorText}>{failingLabel}</Text>
          </View>
        )}

        <View style={[styles.settingRow, { marginTop: 24 }]}>
          <Text style={styles.settingLabel}>Delete original after import</Text>

          <Switch
            testID="delete-original-switch"
            value={settings.delete_original_after_import}
            onValueChange={(enabled) => updateSettings({ ...settings, delete_original_after_import: enabled })}
            trackColor={{ false: Color.TEXT_DISABLED, true: Color.PRIMARY }}
            thumbColor={Color.TEXT}
          />
        </View>

        <View style={styles.settingSecondary}>
          <Text style={styles.secondaryText}>
            {settings.delete_original_after_import ? 'Enabled' : 'Disabled'}
          </Text>
        </View>

        <TouchableOpacity
          testID="about-row"
          style={{ marginTop: 24 }}
          onPress={() => router.push('/about')}
        >
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>About Ivy</Text>
          </View>
          <View style={styles.settingSecondary}>
            <Text style={styles.secondaryText}>Version and licenses</Text>
          </View>
        </TouchableOpacity>

      </View>
    </ScreenArea>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  settingLabel: {
    fontSize: 18,
    color: Color.TEXT,
  },
  settingSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  secondaryText: {
    fontSize: 14,
    color: Color.TEXT_3,
  },
  errorText: {
    fontSize: 14,
    color: Color.DESTRUCTIVE,
  },
  linkText: {
    fontSize: 14,
    color: Color.PRIMARY,
  },
})
