import { View, Text, StyleSheet, Switch, TouchableOpacity, Alert } from 'react-native'
import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import { Color } from '../theme'
import { useStore } from '../store'

export default function SettingsScreen() {
  const { settings, updateSettings, sync, syncNow, refreshSyncStatus } = useStore()

  useFocusEffect(
    useCallback(() => {
      refreshSyncStatus()
    }, [refreshSyncStatus])
  )

  const handleSyncNow = async () => {
    const result = await syncNow()
    if (!result.success && result.error) {
      Alert.alert('Sync Failed', result.error)
    }
  }

  const pendingLabel = sync.pendingCount === 1 ? '1 item pending' : `${sync.pendingCount} items pending`

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
            {sync.pendingCount > 0 ? pendingLabel : 'Up to date'}
          </Text>

          <Text style={styles.secondaryText}> · </Text>

          <TouchableOpacity onPress={handleSyncNow} disabled={sync.isSyncing}>
            <Text style={styles.linkText}>
              {sync.isSyncing ? 'Syncing...' : 'Sync now'}
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
