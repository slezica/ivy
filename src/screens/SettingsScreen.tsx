import { View, Text, StyleSheet, Switch, TouchableOpacity, Alert } from 'react-native'
import { useState, useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import { Color } from '../theme'
import { googleAuthService, backupSyncService, offlineQueueService } from '../services'
import { useStore } from '../store'

export default function SettingsScreen() {
  const { fetchBooks, fetchAllClips, settings, updateSettings } = useStore()
  const [isSyncing, setIsSyncing] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  useFocusEffect(
    useCallback(() => {
      setPendingCount(offlineQueueService.getCount())
    }, [])
  )

  const handleSyncNow = async () => {
    if (isSyncing) return

    setIsSyncing(true)

    try {
      await googleAuthService.initialize()

      if (!googleAuthService.isAuthenticated()) {
        const signedIn = await googleAuthService.signIn()
        if (!signedIn) {
          Alert.alert('Auth Failed', 'Could not sign in to Google')
          return
        }
      }

      const result = await backupSyncService.sync()

      fetchBooks()
      fetchAllClips()
      setPendingCount(offlineQueueService.getCount())

      console.log('Sync complete:', {
        uploaded: result.uploaded,
        downloaded: result.downloaded,
        deleted: result.deleted,
        conflicts: result.conflicts.length,
        errors: result.errors.length,
      })

      if (result.errors.length > 0) {
        Alert.alert('Sync Errors', `${result.errors.length} error(s) occurred during sync`)
      }
    } catch (error) {
      console.error('Sync failed:', error)
      Alert.alert('Sync Failed', `${error}`)
    } finally {
      setIsSyncing(false)
    }
  }

  const pendingLabel = pendingCount === 1 ? '1 item pending' : `${pendingCount} items pending`

  return (
    <ScreenArea>
      <Header title="Settings" />

      <View style={styles.content}>
        <View style={styles.settingRow}>
          <Text style={styles.settingLabel}>Sync</Text>

          <Switch
            value={settings.sync_enabled}
            onValueChange={(value) => updateSettings({ ...settings, sync_enabled: value })}
            trackColor={{ false: Color.GRAY, true: Color.PRIMARY }}
            thumbColor={Color.BLACK}
          />
        </View>

        <View style={styles.settingSecondary}>
          <Text style={styles.secondaryText}>
            {pendingCount > 0 ? pendingLabel : 'Up to date'}
          </Text>

          <Text style={styles.secondaryText}> · </Text>

          <TouchableOpacity onPress={handleSyncNow} disabled={isSyncing}>
            <Text style={styles.linkText}>
              {isSyncing ? 'Syncing...' : 'Sync now'}
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
    fontSize: 16,
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
  linkText: {
    fontSize: 14,
    color: Color.PRIMARY,
  },
})
