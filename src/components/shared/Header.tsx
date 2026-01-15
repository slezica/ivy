import { View, Text, StyleSheet } from 'react-native'
import { Color } from '../../theme'

interface HeaderProps {
  title: string
  subtitle?: string
  children?: React.ReactNode
  noBorder?: boolean
}

export default function Header({ title, subtitle, children, noBorder }: HeaderProps) {
  return (
    <View style={[styles.container, noBorder && styles.noBorder]}>
      <View style={styles.titleArea}>
        <Text style={styles.title}>{title}</Text>
        {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Color.GRAY_LIGHT,
  },
  titleArea: {
    flex: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: Color.BLACK,
  },
  subtitle: {
    fontSize: 14,
    color: Color.GRAY_DARK,
    marginTop: 4,
  },
  noBorder: {
    borderBottomWidth: 0,
  },
})
