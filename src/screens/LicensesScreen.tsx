import { View, Text, StyleSheet, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import ScreenArea from '../components/shared/ScreenArea'
import Header from '../components/shared/Header'
import { Color } from '../theme'
import { GPL3_TEXT } from './licenses/gpl3'

const NOTICES = [
  { name: 'React Native & Expo', license: 'MIT' },
  { name: 'react-native-track-player', license: 'Apache-2.0' },
  { name: 'Skia (@shopify/react-native-skia)', license: 'BSD-3-Clause / MIT' },
  { name: 'whisper.rn & whisper.cpp', license: 'MIT' },
  { name: 'zustand & immer', license: 'MIT' },
  { name: '@react-native-google-signin', license: 'MIT' },
  { name: 'OpenSSL (libcrypto)', license: 'Apache-2.0' },
  { name: 'expat', license: 'MIT' },
]

export default function LicensesScreen() {
  const router = useRouter()

  return (
    <ScreenArea>
      <Header title="Licenses" icon="chevron-back" onIconPress={() => router.back()} />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Ivy</Text>
        <Text style={styles.body}>
          Ivy is open source under the MIT license.
        </Text>

        <Text style={styles.heading}>Open source components</Text>
        {NOTICES.map((n) => (
          <View key={n.name} style={styles.noticeRow}>
            <Text style={styles.noticeName}>{n.name}</Text>
            <Text style={styles.noticeLicense}>{n.license}</Text>
          </View>
        ))}

        <Text style={styles.heading}>FFmpeg</Text>
        <Text style={styles.body}>
          Ivy bundles a prebuilt FFmpeg runtime (used for clip extraction and
          chapter metadata), executed as a standalone program. It is a
          termux-packages build of FFmpeg, licensed under the GNU General
          Public License version 3. Source code: ffmpeg.org and
          github.com/termux/termux-packages (ffmpeg package). The full license
          text follows.
        </Text>
        <Text style={styles.licenseText}>{GPL3_TEXT}</Text>
      </ScrollView>
    </ScreenArea>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  heading: {
    fontSize: 18,
    color: Color.TEXT,
    marginTop: 16,
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: Color.TEXT_3,
    lineHeight: 20,
  },
  noticeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  noticeName: {
    fontSize: 14,
    color: Color.TEXT_3,
    flexShrink: 1,
  },
  noticeLicense: {
    fontSize: 14,
    color: Color.TEXT_3,
    marginLeft: 12,
  },
  licenseText: {
    fontSize: 11,
    color: Color.TEXT_3,
    fontFamily: 'monospace',
    marginTop: 8,
  },
})
