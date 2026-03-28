/**
 * Modal
 *
 * Reusable modal wrapper with overlay and centered content.
 */

import { useCallback, useRef } from 'react'
import { Modal, View, ScrollView, KeyboardAvoidingView, Platform, Animated, Pressable, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { Color } from '../../theme'

const SCROLL_MORE_THRESHOLD = 20

interface ModalProps {
  visible: boolean
  onClose: () => void
  children: React.ReactNode
}

export default function Dialog({ visible, onClose, children }: ModalProps) {
  const opacity = useRef(new Animated.Value(0)).current
  const canScrollMore = useRef(false)

  const fadeIndicator = useCallback((show: boolean) => {
    Animated.timing(opacity, {
      toValue: show ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start()
  }, [opacity])

  const contentHeight = useRef(0)
  const layoutHeight = useRef(0)
  const scrollY = useRef(0)

  const updateIndicator = useCallback(() => {
    const remaining = contentHeight.current - layoutHeight.current - scrollY.current
    const shouldShow = remaining > SCROLL_MORE_THRESHOLD

    if (shouldShow !== canScrollMore.current) {
      canScrollMore.current = shouldShow
      fadeIndicator(shouldShow)
    }
  }, [fadeIndicator])

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <SafeAreaView style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={onClose} />
          <View style={styles.content}>
            <ScrollView
              bounces={false}
              onContentSizeChange={(_, h) => { contentHeight.current = h; updateIndicator() }}
              onLayout={(e) => { layoutHeight.current = e.nativeEvent.layout.height; updateIndicator() }}
              onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; updateIndicator() }}
              scrollEventThrottle={16}
            >
              {children}
            </ScrollView>

            <Animated.View style={[styles.scrollIndicator, { opacity }]} pointerEvents="none">
              <Ionicons name="chevron-down" size={18} color={Color.TEXT_2} />
            </Animated.View>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  )
}


const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Color.BACKDROP,
  },
  content: {
    backgroundColor: Color.BACKGROUND,
    borderRadius: 12,
    width: '100%',
    maxWidth: 400,
    overflow: 'hidden',
  },
  scrollIndicator: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 1000,
    backgroundColor: Color.BACKGROUND_2,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
