import { TouchableOpacity, StyleSheet, ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color } from '../../theme'


interface IconButtonProps {
  iconName: keyof typeof Ionicons.glyphMap
  onPress: () => void
  size?: number
  backgroundColor?: string
  iconColor?: string
  style?: ViewStyle
}


export default function IconButton({
  iconName,
  onPress,
  size = 64,
  backgroundColor = Color.PRIMARY,
  iconColor = Color.BLACK,
  style,
}: IconButtonProps) {
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
          backgroundColor,
        },
        style,
      ]}
      onPress={onPress}
    >
      <Ionicons name={iconName} size={iconSize} color={iconColor} />
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  button: {
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Color.PRIMARY,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 4,
  },
})
