import { View, Text, StyleSheet, Switch, TouchableOpacity, Alert } from 'react-native'
import { useCallback, useState, useEffect } from 'react'
import { useFocusEffect, useRouter } from 'expo-router'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import { Color } from '../theme'
import { useStore } from '../store'
import { downloader } from '../services'

export default function SettingsScreen() {
  const router = useRouter()
  const { settings, updateSettings, sync, syncNow, refreshSyncStatus, transcription, startTranscription, stopTranscription, loadFileWithUri, fetchBooks, __DEV_resetApp } = useStore()

  const [ytdlpVersion, setYtdlpVersion] = useState<string | null>(null)
  const [isUpdatingYtdlp, setIsUpdatingYtdlp] = useState(false)

  useFocusEffect(
    useCallback(() => {
      refreshSyncStatus()
      downloader.version().then(setYtdlpVersion).catch(() => {})
    }, [refreshSyncStatus])
  )

  const pendingLabel = sync.pendingCount === 1 ? '1 item pending' : `${sync.pendingCount} items pending`

  function handleSyncToggle(enabled: boolean) {
    updateSettings({ ...settings, sync_enabled: enabled })

    if (enabled && sync.pendingCount > 0) {
      syncNow()
    }
  }

  async function handleUpdateYtdlp() {
    if (isUpdatingYtdlp) return
    setIsUpdatingYtdlp(true)

    try {
      const status = await downloader.update()
      const version = await downloader.version()
      setYtdlpVersion(version)

      if (status === 'ALREADY_UP_TO_DATE') {
        Alert.alert('Up to date', 'YouTube downloader is already up to date')
      } else {
        Alert.alert('Updated', 'YouTube downloader has been updated')
      }
    } catch (error) {
      Alert.alert('Update failed', 'Could not update the YouTube downloader')
    } finally {
      setIsUpdatingYtdlp(false)
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

  async function handleLoadSample() {
    try {
      const { Asset } = await import('expo-asset')
      const asset = Asset.fromModule(require('../../assets/test/test-audio.mp3'))
      await asset.downloadAsync()
      if (!asset.localUri) throw new Error('Failed to download test asset')
      await loadFileWithUri(asset.localUri, 'test-audio.mp3')
      fetchBooks()
      router.replace('/player')
    } catch (error) {
      console.error('Error loading test file:', error)
      Alert.alert('Error', 'Failed to load test file')
    }
  }

  function handleReset() {
    Alert.alert(
      'Reset App',
      'This will clear all files, clips, and playback data. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await __DEV_resetApp()
            } catch (error) {
              console.error('Error resetting app:', error)
              Alert.alert('Error', 'Failed to reset app')
            }
          },
        },
      ]
    )
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
            trackColor={{ false: Color.GRAY, true: Color.PRIMARY }}
            thumbColor={Color.BLACK}
          />
        </View>

        {transcription.status !== 'idle' && (
          <View style={styles.settingSecondary}>
            <Text style={styles.secondaryText}>
              {transcription.status === 'downloading' ? 'Downloading model...' : 'Processing...'}
            </Text>
          </View>
        )}

        <View style={[styles.settingRow, { marginTop: 24 }]}>
          <Text style={styles.settingLabel}>Sync to Google Drive</Text>

          <Switch
            value={settings.sync_enabled}
            onValueChange={handleSyncToggle}
            trackColor={{ false: Color.GRAY, true: Color.PRIMARY }}
            thumbColor={Color.BLACK}
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
            {ytdlpVersion ?? '...'}
          </Text>

          <Text style={styles.secondaryText}> · </Text>

          <TouchableOpacity onPress={handleUpdateYtdlp} disabled={isUpdatingYtdlp}>
            <Text style={styles.linkText}>
              {isUpdatingYtdlp ? 'Updating...' : 'Update'}
            </Text>
          </TouchableOpacity>
        </View>

        {__DEV__ && (
          <>
            <Text style={styles.sectionHeader}>Developer</Text>

            <TouchableOpacity style={styles.devButton} onPress={handleLoadSample}>
              <Text style={styles.devButtonText}>Load Sample</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.devButton} onPress={handleReset}>
              <Text style={styles.devButtonDestructive}>Reset App</Text>
            </TouchableOpacity>
          </>
        )}
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
    color: Color.BLACK,
  },
  settingSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryText: {
    fontSize: 14,
    color: Color.GRAY_MEDIUM,
  },
  errorText: {
    fontSize: 14,
    color: Color.DESTRUCTIVE,
  },
  linkText: {
    fontSize: 14,
    color: Color.PRIMARY,
  },
  sectionHeader: {
    fontSize: 14,
    fontWeight: '600',
    color: Color.GRAY_DARK,
    marginTop: 32,
    marginBottom: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  devButton: {
    paddingVertical: 12,
  },
  devButtonText: {
    fontSize: 16,
    color: Color.PRIMARY,
  },
  devButtonDestructive: {
    fontSize: 16,
    color: Color.DESTRUCTIVE,
  },
})
