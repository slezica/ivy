/**
 * FileService
 *
 * Wraps expo-document-picker and expo-file-system.
 * Handles file selection and metadata extraction.
 */

import * as DocumentPicker from 'expo-document-picker';

export interface PickedFile {
  uri: string;
  name: string;
}

export class FileService {
  async pickAudioFile(): Promise<PickedFile | null> {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        copyToCacheDirectory: false,
      });

      if (result.canceled) {
        return null;
      }

      const asset = result.assets[0];
      return {
        uri: asset.uri,
        name: asset.name,
      };
    } catch (error) {
      console.error('Error picking audio file:', error);
      throw error;
    }
  }
}
