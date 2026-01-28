import type { FilePickerService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import type { LoadFile } from './load_file'


export interface LoadFileWithPickerDeps {
  picker: FilePickerService
  loadFile: LoadFile
}

export type LoadFileWithPicker = Action<[]>

export const createLoadFileWithPicker: ActionFactory<LoadFileWithPickerDeps, LoadFileWithPicker> = (deps) => (
  async () => {
    const { picker, loadFile } = deps

    const pickedFile = await picker.pickAudioFile()
    if (!pickedFile) return

    await loadFile(pickedFile)
  }
)
