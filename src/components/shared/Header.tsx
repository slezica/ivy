import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color } from '../../theme'

interface HeaderProps {
  title: string
  subtitle?: string
  children?: React.ReactNode
  noBorder?: boolean
  icon?: keyof typeof Ionicons.glyphMap
  onIconPress?: () => void
}

export default function Header({ title, subtitle, children, noBorder, icon, onIconPress }: HeaderProps) {
  return (
    <View style={[styles.container, noBorder && styles.noBorder]}>
      {icon && (
        <TouchableOpacity onPress={onIconPress} style={styles.iconButton}>
          <Ionicons name={icon} size={24} color={Color.BLACK} />
        </TouchableOpacity>
      )}

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
    paddingTop: 16,
    paddingBottom: 12,
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
  iconButton: {
    marginRight: 12,
    marginLeft: -4,
  },
})
