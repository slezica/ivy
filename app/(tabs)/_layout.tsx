import { Tabs } from 'expo-router'

export default function TabsLayout() {
  return (
    <Tabs>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Player',
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="clips"
        options={{
          title: 'Clips',
          headerShown: false,
        }}
      />
    </Tabs>
  )
}
