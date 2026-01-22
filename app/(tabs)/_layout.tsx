import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Pressable } from 'react-native'
import { useStore } from '../../src/store'
import { Color } from '../../src/theme'

export default function TabsLayout() {
  const { playback } = useStore()
  const hasFile = !!playback.uri

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: Color.GRAY_LIGHTER,
          borderTopColor: Color.GRAY_BORDER,
          paddingVertical: 8,
        },
        tabBarActiveTintColor: Color.BLACK,
        tabBarInactiveTintColor: Color.GRAY,
        tabBarIconStyle: {
          marginTop: 4,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Library',
          headerShown: false,
          tabBarIcon: ({ color }) => (
            <Ionicons name="library" size={28} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="player"
        options={{
          title: 'Player',
          headerShown: false,
          tabBarIcon: ({ color }) => (
            <Ionicons name="play-circle" size={28} color={color} />
          ),
          tabBarButton: ({ ref, ...props }) => (
            <Pressable
              ref={ref}
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
          tabBarIcon: ({ color }) => (
            <Ionicons name="list" size={28} color={color} />
          ),
        }}
      />
    </Tabs>
  )
}
