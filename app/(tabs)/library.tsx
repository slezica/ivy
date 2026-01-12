/**
 * LibraryScreen
 *
 * Shows a list of previously opened audio files for quick access.
 */

import { View, Text, StyleSheet, SafeAreaView, Alert } from 'react-native'
import { useStore } from '../../src/store'
import IconButton from '../../src/components/shared/IconButton'
import { Color } from '../../src/theme'

export default function LibraryScreen() {
  const { pickAndLoadFile } = useStore()

  const handleLoadFile = async () => {
    try {
      await pickAndLoadFile()
    } catch (error) {
      console.error(error)
      Alert.alert('Error', 'Failed to load audio file')
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Library</Text>
      </View>

      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>No files yet</Text>
        <Text style={styles.emptySubtext}>
          Open an audio file to add it to your library
        </Text>
      </View>

      {/* FAB */}
      <IconButton
        iconName="add"
        onPress={handleLoadFile}
        size={56}
        style={styles.fab}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Color.WHITE,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Color.GRAY_LIGHT,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: Color.BLACK,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: Color.GRAY_DARK,
  },
  emptySubtext: {
    fontSize: 14,
    color: Color.GRAY_MEDIUM,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
  },
})
