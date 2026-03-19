import { View, Text, StyleSheet, Modal, ActivityIndicator } from 'react-native'
import { useStore } from '../store'
import { Color } from '../theme'

export default function LoadingModal() {
  const { library } = useStore()
  const isVisible = library.status === 'adding'
  const progress = library.copyProgress

  const hasProgress = progress && progress.total > 0
  const percent = hasProgress ? Math.round((progress.bytes / progress.total) * 100) : null

  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.content}>
          <ActivityIndicator size="large" color={Color.PRIMARY} />
          <Text style={styles.text}>Adding to library...</Text>
          {hasProgress && (
            <View style={styles.progressContainer}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${percent}%` }]} />
              </View>
              <Text style={styles.progressText}>{percent}%</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: Color.MODAL_OVERLAY,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    backgroundColor: Color.WHITE,
    borderRadius: 12,
    padding: 32,
    alignItems: 'center',
    gap: 16,
    minWidth: 200,
  },
  text: {
    fontSize: 16,
    color: Color.BLACK,
    fontWeight: '500',
  },
  progressContainer: {
    width: '100%',
    alignItems: 'center',
    gap: 8,
  },
  progressTrack: {
    width: '100%',
    height: 4,
    backgroundColor: Color.GRAY_LIGHT,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: Color.PRIMARY,
    borderRadius: 2,
  },
  progressText: {
    fontSize: 13,
    color: Color.GRAY_MEDIUM,
  },
})
