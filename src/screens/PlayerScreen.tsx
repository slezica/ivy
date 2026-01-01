/**
 * PlayerScreen
 *
 * Main playback screen with controls and progress bar.
 */

import { View, Text, StyleSheet } from 'react-native';

export default function PlayerScreen() {
  return (
    <View style={styles.container}>
      <Text>Player Screen</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
