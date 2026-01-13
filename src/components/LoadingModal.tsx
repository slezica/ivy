import { View, Text, StyleSheet, Modal, ActivityIndicator } from 'react-native'
import { useStore } from '../store'
import { Color } from '../theme'

export default function LoadingModal() {
  const { player } = useStore()
  const isLoading = player.status === 'loading'

  return (
    <Modal
      visible={isLoading}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.content}>
          <ActivityIndicator size="large" color={Color.PRIMARY} />
          <Text style={styles.text}>Loading audio file...</Text>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
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
})
