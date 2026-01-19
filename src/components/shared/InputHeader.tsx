import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color } from '../../theme'

interface InputHeaderProps {
  value: string
  onChangeText: (text: string) => void
  onClose: () => void
  placeholder?: string
}

export default function InputHeader({ value, onChangeText, onClose, placeholder = 'Search...' }: InputHeaderProps) {

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Color.GRAY_DARK}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
      />

      <TouchableOpacity onPress={onClose} style={styles.closeButton}>
        <Ionicons name="close" size={24} color={Color.BLACK} />
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Color.GRAY_LIGHT,
  },
  input: {
    flex: 1,
    fontSize: 18,
    color: Color.BLACK,
    paddingVertical: 4,
  },
  closeButton: {
    marginLeft: 12,
    padding: 4,
  },
})
