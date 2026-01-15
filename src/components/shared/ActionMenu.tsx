import { View, Text, StyleSheet, Modal, Pressable, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { Color } from '../../theme'

export interface ActionMenuItem {
  key: string
  label: string
  icon: keyof typeof Ionicons.glyphMap
  destructive?: boolean
}

interface ActionMenuProps {
  visible: boolean
  onClose: () => void
  onAction: (key: string) => void
  items: ActionMenuItem[]
}

export default function ActionMenu({ visible, onClose, onAction, items }: ActionMenuProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <View style={styles.content}>
          {items.map((item, index) => (
            <TouchableOpacity
              key={item.key}
              style={[
                styles.item,
                item.destructive && styles.itemDestructive,
                index > 0 && styles.itemBorder,
              ]}
              onPress={() => onAction(item.key)}
            >
              <Ionicons
                name={item.icon}
                size={20}
                color={item.destructive ? Color.DESTRUCTIVE : Color.BLACK}
              />
              <Text style={[
                styles.itemText,
                item.destructive && styles.itemTextDestructive,
              ]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: Color.MODAL_OVERLAY,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  content: {
    backgroundColor: Color.WHITE,
    borderRadius: 12,
    width: '100%',
    maxWidth: 300,
    overflow: 'hidden',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  itemBorder: {
    borderTopWidth: 1,
    borderTopColor: Color.GRAY_LIGHT,
  },
  itemDestructive: {},
  itemText: {
    fontSize: 16,
    color: Color.BLACK,
  },
  itemTextDestructive: {
    color: Color.DESTRUCTIVE,
  },
})
