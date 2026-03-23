/**
 * Modal
 *
 * Reusable modal wrapper with overlay and centered content.
 */

import { Modal, View, ScrollView, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Color } from '../../theme'


interface ModalProps {
  visible: boolean
  onClose: () => void
  children: React.ReactNode
}

export default function Dialog({ visible, onClose, children }: ModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.overlay}>
        <View style={styles.content}>
          <ScrollView bounces={false}>
            {children}
          </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  )
}


const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: Color.MODAL_OVERLAY,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: {
    backgroundColor: Color.WHITE,
    borderRadius: 12,
    width: '100%',
    maxWidth: 400,
    overflow: 'hidden',
  },
})
