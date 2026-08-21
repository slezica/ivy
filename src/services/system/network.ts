/**
 * Network Service
 *
 * Thin wrapper around NetInfo exposing connectivity + metered state as typed
 * events. Used to gate the transcription model download (465MB) off metered
 * connections and to auto-retry when connectivity returns.
 */

import NetInfo from '@react-native-community/netinfo'
import { BaseService } from '../base'
import { createLogger } from '../../utils'

const log = createLogger('Network')

export interface NetworkState {
  connected: boolean
  metered: boolean
}

export type NetworkServiceEvents = {
  change: NetworkState
}

export class NetworkService extends BaseService<NetworkServiceEvents> {
  private state: NetworkState = { connected: false, metered: false }
  private started = false

  /** Begin listening for connectivity changes. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true

    NetInfo.addEventListener((netState) => {
      const next: NetworkState = {
        connected: netState.isConnected ?? false,
        metered: netState.details?.isConnectionExpensive ?? false,
      }

      if (next.connected === this.state.connected && next.metered === this.state.metered) {
        return
      }

      log('Network changed:', next)
      this.state = next
      this.emit('change', next)
    })
  }

  getState(): NetworkState {
    return this.state
  }

  /** One-shot query, independent of the listener. */
  async fetch(): Promise<NetworkState> {
    const netState = await NetInfo.fetch()
    return {
      connected: netState.isConnected ?? false,
      metered: netState.details?.isConnectionExpensive ?? false,
    }
  }
}
