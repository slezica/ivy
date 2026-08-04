/**
 * Google OAuth Service
 *
 * Handles authentication with Google for Drive API access.
 * Uses @react-native-google-signin for native OAuth flow.
 *
 * The native library manages token refresh internally - we just call getTokens()
 * and it returns a fresh access token.
 */

import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin'
import { createLogger } from '../../utils'

const log = createLogger('GoogleAuth')

// No webClientId: we only use access tokens (getTokens), issued against the
// Android OAuth clients (package + signing cert) in Google Cloud Console.
// Only needed for idToken/serverAuthCode — and must be a web-type client then.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
]

class GoogleAuthService {
  private configured = false
  private tokenPromise: Promise<string | null> | null = null

  /**
   * Configure the service. Must be called before other methods.
   */
  async initialize(): Promise<void> {
    if (this.configured) return

    GoogleSignin.configure({
      scopes: SCOPES,
      offlineAccess: false,
    })
    this.configured = true
    log('Configured')
  }

  /**
   * Check if user has previously signed in.
   */
  isAuthenticated(): boolean {
    return GoogleSignin.hasPreviousSignIn()
  }

  /**
   * Get a valid access token.
   * The native library handles token refresh automatically.
   */
  async getAccessToken(): Promise<string | null> {
    // Serialize concurrent calls to avoid racing signInSilently
    if (this.tokenPromise) return this.tokenPromise

    this.tokenPromise = this.fetchAccessToken()
    try {
      return await this.tokenPromise
    } finally {
      this.tokenPromise = null
    }
  }

  private async fetchAccessToken(): Promise<string | null> {
    await this.initialize()

    try {
      if (GoogleSignin.hasPreviousSignIn()) {
        await GoogleSignin.signInSilently()
      } else {
        return null
      }

      const tokens = await GoogleSignin.getTokens()
      return tokens.accessToken
    } catch (error: any) {
      if (error.code === statusCodes.SIGN_IN_REQUIRED) {
        return null
      }
      log('Failed to get access token:', error)
      return null
    }
  }

  /**
   * Start the OAuth sign-in flow.
   */
  async signIn(): Promise<boolean> {
    await this.initialize()

    try {
      // Try silent sign-in first
      if (GoogleSignin.hasPreviousSignIn()) {
        try {
          await GoogleSignin.signInSilently()
          log('Restored previous session')
          return true
        } catch {
          // Fall through to interactive sign-in
        }
      }

      // Interactive sign-in
      const result = await GoogleSignin.signIn()
      log('Signed in as:', result.data?.user.email)
      return true
    } catch (error: any) {
      if (error.code === statusCodes.SIGN_IN_CANCELLED) {
        log('Sign-in cancelled')
      } else if (error.code === statusCodes.IN_PROGRESS) {
        log('Sign-in in progress')
      } else if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        log('Play Services unavailable')
      } else {
        log('Sign-in failed:', error)
      }
      return false
    }
  }

  /**
   * Sign out.
   */
  async signOut(): Promise<void> {
    try {
      await GoogleSignin.signOut()
      log('Signed out')
    } catch (error) {
      log('Sign out failed:', error)
    }
  }
}

export { GoogleAuthService }
