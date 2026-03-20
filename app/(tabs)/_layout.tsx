import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useStore } from '../../src/store'
import { Color } from '../../src/theme'

const DEFAULT_TAB_BAR_HEIGHT = 49 // taken from Router source
const TAB_BAR_EXTRA_HEIGHT = 8

export default function TabsLayout() {
  const { playback } = useStore()
  const hasFile = !!playback.uri
  const insets = useSafeAreaInsets()

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: Color.GRAY_LIGHTER,
          borderTopColor: Color.GRAY_BORDER,
          height: DEFAULT_TAB_BAR_HEIGHT + TAB_BAR_EXTRA_HEIGHT + insets.bottom,
          paddingTop: TAB_BAR_EXTRA_HEIGHT / 2
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
              ref={ref as React.Ref<View>}
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
