import { TouchableOpacity, StyleSheet, ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color } from '../../theme'


interface IconButtonProps {
  iconName: keyof typeof Ionicons.glyphMap
  onPress: () => void
  onLongPress?: () => void
  testID?: string
  size?: number
  variant?: 'filled' | 'outline'
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
  variant = 'filled',
  backgroundColor,
  iconColor,
  style,
}: IconButtonProps) {
  const outline = variant === 'outline'
  const background = backgroundColor ?? (outline ? 'transparent' : Color.PRIMARY)
  const icon = iconColor ?? (outline ? Color.PRIMARY : Color.PRIMARY_CONTRAST)

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
        outline && styles.outline,
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
  button: {
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
  outline: {
    borderWidth: 1.5,
    borderColor: Color.PRIMARY,
    elevation: 0,
  },
})
