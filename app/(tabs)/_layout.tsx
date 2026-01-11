import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Color } from '../../src/theme'

export default function TabsLayout() {
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
          title: 'Player',
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="play-circle" size={size} color={color} />
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
        }}
      />
    </Tabs>
  )
}
