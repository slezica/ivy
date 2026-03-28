import { View, Text, StyleSheet, Modal, ActivityIndicator } from 'react-native'
import { useStore } from '../store'
import { Color } from '../theme'
import TextButton from './shared/TextButton'

export default function LibraryLoadingDialog() {
  const { library, cancelLoadFile } = useStore()

  const isAdding = library.status === 'adding'
  const isDuplicate = library.status === 'duplicate'
  const isError = library.status === 'error'
  const isVisible = isAdding || isDuplicate || isError

  const percent = library.addProgress
  const isActive = library.addOpId !== null

  const dismiss = () => useStore.setState(state => { state.library.status = 'idle' })

  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.content}>
          {isAdding && (
            <>
              <ActivityIndicator size="large" color={Color.PRIMARY} />
              <Text style={styles.text}>Adding to library...</Text>
              {percent !== null && (
                <View style={styles.progressContainer}>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${percent}%` }]} />
                  </View>
                </View>
              )}
              {library.message && (
                <Text style={styles.messageText}>{library.message}</Text>
              )}
              {isActive && (
                <View style={styles.buttons}>
                  <TextButton label="Cancel" onPress={cancelLoadFile} style={{ flex: 1 }} />
                </View>
              )}
            </>
          )}
          {isDuplicate && (
            <>
              <Text style={styles.text}>This file is already in your library</Text>
              <View style={styles.buttons}>
                <TextButton label="OK" onPress={dismiss} variant="primary" style={{ flex: 1 }} />
              </View>
            </>
          )}
          {isError && (
            <>
              <Text style={styles.text}>Something went wrong adding this file</Text>
              <View style={styles.buttons}>
                <TextButton label="OK" onPress={dismiss} variant="primary" style={{ flex: 1 }} />
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: Color.BACKDROP,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    backgroundColor: Color.BACKGROUND,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    gap: 16,
    minWidth: 200,
  },
  buttons: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  text: {
    fontSize: 16,
    color: Color.TEXT,
    fontWeight: '500',
  },
  progressContainer: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4
  },
  progressTrack: {
    alignSelf: 'stretch',
    height: 4,
    backgroundColor: Color.TEXT_DISABLED,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: Color.PRIMARY,
    borderRadius: 2,
  },
  messageText: {
    fontSize: 13,
    fontStyle: 'italic',
    color: Color.TEXT_3,
  },
})
