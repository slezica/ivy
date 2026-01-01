/**
 * PlaybackControls
 *
 * Play/pause and skip forward/backward buttons.
 */

import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useStore } from '../store';

export default function PlaybackControls() {
  const { playback, play, pause, skipForward, skipBackward } = useStore();

  const handlePlayPause = async () => {
    try {
      if (playback.isPlaying) {
        await pause();
      } else {
        await play();
      }
    } catch (error) {
      console.error('Playback error:', error);
    }
  };

  const handleSkipBackward = async () => {
    try {
      await skipBackward();
    } catch (error) {
      console.error('Skip backward error:', error);
    }
  };

  const handleSkipForward = async () => {
    try {
      await skipForward();
    } catch (error) {
      console.error('Skip forward error:', error);
    }
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={handleSkipBackward}>
        <Text style={styles.buttonText}>-30s</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.playButton} onPress={handlePlayPause}>
        <Text style={styles.playButtonText}>
          {playback.isPlaying ? '⏸' : '▶'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.button} onPress={handleSkipForward}>
        <Text style={styles.buttonText}>+25s</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    paddingVertical: 20,
  },
  button: {
    backgroundColor: '#ddd',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderRadius: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  playButton: {
    backgroundColor: '#007AFF',
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButtonText: {
    fontSize: 32,
    color: '#fff',
  },
});
