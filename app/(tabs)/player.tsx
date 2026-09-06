import { useLocalSearchParams } from 'expo-router'

import PlayerScreen from '../../src/screens/PlayerScreen'

export default function PlayerTab() {
  // Test affordance: ivy://player?seek=<ms>&n=<nonce> (bin/ivy.ts drive --seek)
  const { seek, n } = useLocalSearchParams<{ seek?: string, n?: string }>()
  const seekRequest = seek !== undefined ? { position: Number(seek), nonce: n ?? seek } : null
  return <PlayerScreen seekRequest={seekRequest} />
}
