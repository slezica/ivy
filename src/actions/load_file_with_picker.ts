import type { FilePickerService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import type { LoadFile } from './load_file'
import { createLogger } from '../utils'


export interface LoadFileWithPickerDeps {
  picker: FilePickerService
  loadFile: LoadFile
}

export type LoadFileWithPicker = Action<[]>

export const createLoadFileWithPicker: ActionFactory<LoadFileWithPickerDeps, LoadFileWithPicker> = (deps) => (
  async () => {
    const { picker, loadFile } = deps
    const log = createLogger('LoadFileWithPicker')

    const pickedFile = await picker.pickAudioFile()
    if (!pickedFile) return

    log(`Picked "${pickedFile.name}"`)

    await loadFile(pickedFile)
  }
)
