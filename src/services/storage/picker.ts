/**
 * File Picker Service
 *
 * Wraps expo-document-picker for audio file selection.
 */

import * as DocumentPicker from 'expo-document-picker'

// =============================================================================
// Public Interface
// =============================================================================

export interface PickedFile {
  uri: string
  name: string
}

// =============================================================================
// Service
// =============================================================================

export class FilePickerService {
  async pickAudioFile(): Promise<PickedFile | null> {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: false,
      })

      if (result.canceled) {
        return null
      }

      const asset = result.assets[0]
      return {
        uri: asset.uri,
        name: asset.name,
      }
    } catch (error) {
      console.error('Error picking audio file:', error)
      throw error
    }
  }
}

