/**
 * Modal
 *
 * Reusable modal wrapper with overlay and centered content.
 */

import { Modal as RNModal, View, StyleSheet } from 'react-native'
import { Color } from '../../theme'


interface ModalProps {
  visible: boolean
  onClose: () => void
  children: React.ReactNode
}

export default function Modal({ visible, onClose, children }: ModalProps) {
  return (
    <RNModal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.content}>
          {children}
        </View>
      </View>
    </RNModal>
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
