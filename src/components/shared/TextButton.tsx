import { TouchableOpacity, Text, StyleSheet, ViewStyle } from 'react-native'
import { Color } from '../../theme'

type Variant = 'primary' | 'secondary'

interface TextButtonProps {
  label: string
  onPress: () => void
  variant?: Variant
  style?: ViewStyle
}

export default function TextButton({
  label,
  onPress,
  variant = 'secondary',
  style,
}: TextButtonProps) {
  return (
    <TouchableOpacity
      style={[styles.button, variantStyles[variant].button, style]}
      onPress={onPress}
    >
      <Text style={[styles.label, variantStyles[variant].label]}>{label}</Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
  },
})

const variantStyles = {
  primary: StyleSheet.create({
    button: { backgroundColor: Color.PRIMARY },
    label: { color: Color.BACKGROUND },
  }),
  secondary: StyleSheet.create({
    button: { backgroundColor: Color.BACKGROUND_2 },
    label: { color: Color.TEXT_MUTED },
  }),
}
