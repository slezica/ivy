import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Pressable } from 'react-native'
import { useStore } from '../../src/store'
import { Color } from '../../src/theme'

export default function TabsLayout() {
  const { file } = useStore()
  const hasFile = !!file

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: Color.GRAY_LIGHTER,
          borderTopColor: Color.GRAY_BORDER,
        },
        tabBarActiveTintColor: Color.BLACK,
        tabBarInactiveTintColor: Color.GRAY,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Library',
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="library" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="player"
        options={{
          title: 'Player',
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="play-circle" size={size} color={color} />
          ),
          tabBarButton: (props) => (
            <Pressable
              {...props}
              onPress={hasFile ? props.onPress : undefined}
              style={[props.style, !hasFile && { opacity: 0.3 }]}
            >
              {props.children}
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen
        name="clips"
        options={{
          title: 'Clips',
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list" size={size} color={color} />
          ),
          tabBarButton: (props) => (
            <Pressable
              {...props}
              onPress={hasFile ? props.onPress : undefined}
              style={[props.style, !hasFile && { opacity: 0.3 }]}
            >
              {props.children}
            </Pressable>
          ),
        }}
      />
    </Tabs>
  )
}
