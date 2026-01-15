import { StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Color } from '../../theme'

interface ScreenAreaProps {
  children: React.ReactNode
}

export default function ScreenArea({ children }: ScreenAreaProps) {
  return (
    <SafeAreaView style={styles.container}>
      {children}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Color.WHITE,
  },
})
