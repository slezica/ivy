import { TouchableOpacity, StyleSheet, ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color } from '../../theme'


interface IconButtonProps {
  iconName: keyof typeof Ionicons.glyphMap
  onPress: () => void
  onLongPress?: () => void
  testID?: string
  size?: number
  active?: boolean
  backgroundColor?: string
  iconColor?: string
  style?: ViewStyle
}


export default function IconButton({
  iconName,
  onPress,
  onLongPress,
  testID,
  size = 64,
  active = false,
  backgroundColor,
  iconColor,
  style,
}: IconButtonProps) {
  const background = backgroundColor ?? (active ? Color.PRIMARY : 'transparent')
  const icon = iconColor ?? (active ? Color.PRIMARY_CONTRAST : Color.PRIMARY)

  // Calculate icon size as 50% of button size for balanced appearance
  const iconSize = Math.round(size * 0.5)

  return (
    <TouchableOpacity
      style={[
        styles.button,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: background,
        },
        active && styles.active,
        style,
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
    >
      <Ionicons name={iconName} size={iconSize} color={icon} />
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  // Border always present (invisible against active fill) so size never shifts
  button: {
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Color.PRIMARY,
  },
  active: {
    elevation: 4,
  },
})
