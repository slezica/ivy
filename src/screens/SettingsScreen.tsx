import { View, Text, StyleSheet, Switch, TouchableOpacity } from 'react-native'
import { useCallback } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import { Color, Space } from '../theme'
import { useStore } from '../store'

export default function SettingsScreen() {
  const router = useRouter()
  const { settings, updateSettings, sync, syncNow, fetchSyncState, downloader, fetchDownloaderState, updateDownloader, transcription, startTranscription, stopTranscription } = useStore()

  useFocusEffect(
    useCallback(() => {
      fetchSyncState()
      fetchDownloaderState()
    }, [fetchSyncState, fetchDownloaderState])
  )

  const pendingLabel = sync.pendingCount === 1 ? '1 item pending' : `${sync.pendingCount} items pending`

  function handleSyncToggle(enabled: boolean) {
    updateSettings({ ...settings, sync_enabled: enabled })

    if (enabled && sync.pendingCount > 0) {
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
            value={settings.transcription_enabled}
            onValueChange={handleTranscriptionToggle}
            trackColor={{ false: Color.TEXT_DISABLED, true: Color.PRIMARY }}
            thumbColor={Color.TEXT}
          />
        </View>

        {transcription.status !== 'off' && (
          <View style={styles.settingSecondary}>
            <Text style={transcription.status === 'error' ? styles.errorText : styles.secondaryText}>
              {transcription.status === 'starting' && 'Starting...'}
              {transcription.status === 'on' && 'Ready'}
              {transcription.status === 'error' && 'Failed to start'}
            </Text>

            {transcription.status === 'error' && (
              <>
                <Text style={styles.secondaryText}> · </Text>
                <TouchableOpacity onPress={() => startTranscription()}>
                  <Text style={styles.linkText}>Retry</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        <View style={[styles.settingRow, { marginTop: 24 }]}>
          <Text style={styles.settingLabel}>Sync metadata to Drive</Text>

          <Switch
            value={settings.sync_enabled}
            onValueChange={handleSyncToggle}
            trackColor={{ false: Color.TEXT_DISABLED, true: Color.PRIMARY }}
            thumbColor={Color.TEXT}
          />
        </View>

        <View style={styles.settingSecondary}>
          <Text style={styles.secondaryText}>
            {sync.pendingCount > 0 ? pendingLabel : 'Up to date'}
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

        <View style={[styles.settingRow, { marginTop: 24 }]}>
          <Text style={styles.settingLabel}>YouTube downloader</Text>
        </View>

        <View style={styles.settingSecondary}>
          <Text style={styles.secondaryText}>
            {downloader.version ?? '...'}
          </Text>

          <Text style={styles.secondaryText}> · </Text>

          <TouchableOpacity onPress={updateDownloader} disabled={downloader.status === 'updating'}>
            <Text style={styles.linkText}>
              {downloader.status === 'updating' ? 'Updating...' : 'Update'}
            </Text>
          </TouchableOpacity>
        </View>

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
    marginTop: 8,
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
