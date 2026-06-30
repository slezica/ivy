import { createCancelLoadFile, CancelLoadFileDeps } from '../cancel_load_file'
import type { AppState } from '../../store/types'
import {
  createMockState, createImmerSet, createMockGet,
  createMockCopier,
} from './helpers'

jest.mock('../../utils', () => ({
  createLogger: () => () => {},
}))


// -- Helpers ------------------------------------------------------------------

function createDeps(libraryOverrides: Partial<AppState['library']> = {}) {
  const state = createMockState({ library: libraryOverrides })

  const deps: CancelLoadFileDeps = {
    copier: createMockCopier(),
    get: createMockGet(state),
    set: createImmerSet(state),
  }

  return { state, deps }
}


// -- Tests --------------------------------------------------------------------
//
// These assert the behavior preserved after the URL-download feature was removed:
// cancelling the in-progress *copy* and resetting library state. cancel_load_file
// now depends only on the copier — there is no downloader branch to assert.

describe('createCancelLoadFile', () => {

  describe('no active operation', () => {
    it('does nothing when there is no operation in progress', async () => {
      const { state, deps } = createDeps({ status: 'idle', addOpId: null })
      const cancel = createCancelLoadFile(deps)

      await cancel()

      expect(deps.copier.cancelCopy).not.toHaveBeenCalled()
      expect(deps.set).not.toHaveBeenCalled()
      expect(state.library.status).toBe('idle')
    })
  })

  describe('active operation', () => {
    it('cancels the in-progress copy by op id', async () => {
      const { deps } = createDeps({ status: 'adding', addOpId: 'op-7' })
      const cancel = createCancelLoadFile(deps)

      await cancel()

      expect(deps.copier.cancelCopy).toHaveBeenCalledWith('op-7')
    })

    it('resets library state to idle immediately', async () => {
      const { state, deps } = createDeps({
        status: 'adding', addProgress: 42, addOpId: 'op-7', message: 'Copying',
      })
      const cancel = createCancelLoadFile(deps)

      await cancel()

      expect(state.library).toMatchObject({
        status: 'idle',
        addProgress: null,
        addOpId: null,
        message: null,
      })
    })

    it('swallows a copier cancellation failure', async () => {
      const { deps } = createDeps({ status: 'adding', addOpId: 'op-7' })
      deps.copier.cancelCopy = jest.fn(async () => { throw new Error('already gone') })
      const cancel = createCancelLoadFile(deps)

      await expect(cancel()).resolves.toBeUndefined()
    })
  })
})
