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

// Web client ID (also need Android client ID configured in Google Cloud Console)
const WEB_CLIENT_ID = '883355617581-9rn0rpcbn6oa0034fe4vg650g2vui622.apps.googleusercontent.com'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
]

class GoogleAuthService {
  private configured = false

  /**
   * Configure the service. Must be called before other methods.
   */
  async initialize(): Promise<void> {
    if (this.configured) return

    GoogleSignin.configure({
      webClientId: WEB_CLIENT_ID,
      scopes: SCOPES,
      offlineAccess: false,
    })
    this.configured = true
    console.log('GoogleAuth configured')
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
    await this.initialize()

    try {
      // Restore session if needed
      if (GoogleSignin.hasPreviousSignIn()) {
        await GoogleSignin.signInSilently()
      } else {
        return null
      }

      // Get tokens (library handles refresh internally)
      const tokens = await GoogleSignin.getTokens()
      return tokens.accessToken
    } catch (error: any) {
      if (error.code === statusCodes.SIGN_IN_REQUIRED) {
        return null
      }
      console.error('Failed to get access token:', error)
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
          console.log('Restored previous session')
          return true
        } catch {
          // Fall through to interactive sign-in
        }
      }

      // Interactive sign-in
      const result = await GoogleSignin.signIn()
      console.log('Signed in as:', result.data?.user.email)
      return true
    } catch (error: any) {
      if (error.code === statusCodes.SIGN_IN_CANCELLED) {
        console.log('Sign-in cancelled')
      } else if (error.code === statusCodes.IN_PROGRESS) {
        console.log('Sign-in in progress')
      } else if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        console.error('Play Services unavailable')
      } else {
        console.error('Sign-in failed:', error)
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
      console.log('Signed out')
    } catch (error) {
      console.warn('Sign out failed:', error)
    }
  }
}

export { GoogleAuthService }
