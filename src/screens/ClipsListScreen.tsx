/**
 * ClipsListScreen
 *
 * Lists all clips/bookmarks for the current file.
 */

import { View, Text, StyleSheet } from 'react-native';

export default function ClipsListScreen() {
  return (
    <View style={styles.container}>
      <Text>Clips List Screen</Text>
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
