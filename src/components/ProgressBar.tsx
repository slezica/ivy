/**
 * ProgressBar
 *
 * Visual progress bar with seek capability and time display.
 */

import { View, Text, StyleSheet, PanResponder } from 'react-native';
import { useStore } from '../store';
import { useRef } from 'react';

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default function ProgressBar() {
  const { playback, seek } = useStore();
  const barWidth = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        handleSeek(evt.nativeEvent.locationX);
      },
      onPanResponderMove: (evt) => {
        handleSeek(evt.nativeEvent.locationX);
      },
    })
  ).current;

  const handleSeek = async (x: number) => {
    if (playback.duration === 0 || barWidth.current === 0) {
      return;
    }

    const ratio = Math.max(0, Math.min(1, x / barWidth.current));
    const position = ratio * playback.duration;

    try {
      await seek(position);
    } catch (error) {
      console.error('Seek error:', error);
    }
  };

  const progress = playback.duration > 0 ? playback.position / playback.duration : 0;

  return (
    <View style={styles.container}>
      <Text style={styles.time}>{formatTime(playback.position)}</Text>

      <View
        style={styles.barContainer}
        onLayout={(e) => {
          barWidth.current = e.nativeEvent.layout.width;
        }}
        {...panResponder.panHandlers}
      >
        <View style={styles.barBackground}>
          <View style={[styles.barProgress, { width: `${progress * 100}%` }]} />
        </View>
      </View>

      <Text style={styles.time}>{formatTime(playback.duration)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    gap: 12,
  },
  time: {
    fontSize: 14,
    color: '#666',
    width: 50,
    textAlign: 'center',
  },
  barContainer: {
    flex: 1,
    height: 40,
    justifyContent: 'center',
  },
  barBackground: {
    height: 4,
    backgroundColor: '#ddd',
    borderRadius: 2,
    overflow: 'hidden',
  },
  barProgress: {
    height: '100%',
    backgroundColor: '#007AFF',
  },
});
