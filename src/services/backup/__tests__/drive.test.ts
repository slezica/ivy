import { GoogleDriveService } from '../drive'
import type { GoogleAuthService } from '../auth'

describe('GoogleDriveService', () => {
  const originalFetch = global.fetch

  function createResponse({
    ok = true,
    json,
    text = '',
    headers = {},
  }: {
    ok?: boolean
    json?: unknown
    text?: string
    headers?: Record<string, string>
  }) {
    return {
      ok,
      json: jest.fn(async () => json),
      text: jest.fn(async () => text),
      headers: {
        get: (key: string) => headers[key] ?? null,
      },
    } as any
  }

  function createAuth(): jest.Mocked<GoogleAuthService> {
    return {
      getAccessToken: jest.fn(async () => 'token'),
    } as any
  }

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('creates the sessions backup folder with the expected name', async () => {
    const auth = createAuth()
    const service = new GoogleDriveService(auth)

    const fetchMock = jest.fn()
    global.fetch = fetchMock as any

    // Search root folder -> found
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [{ id: 'root-folder-id' }] },
    }))

    // Search sessions folder -> not found
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [] },
    }))

    // Create sessions folder
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { id: 'sessions-folder-id' },
    }))

    // Post-create re-query -> only our folder
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [{ id: 'sessions-folder-id', createdTime: '2026-01-01T00:00:00Z' }] },
    }))

    // List files in sessions folder
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [] },
    }))

    await service.listFiles('sessions')

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls[2][1]?.method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string)).toMatchObject({
      name: 'sessions',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root-folder-id'],
    })
    // The listing targets the folder we created and re-queried
    // (listFiles builds its query via URLSearchParams: %27id%27+in+parents)
    expect(fetchMock.mock.calls[4][0]).toContain('%27sessions-folder-id%27+in+parents')
  })

  it('adopts the oldest folder when the search finds duplicates', async () => {
    const auth = createAuth()
    const service = new GoogleDriveService(auth)

    const fetchMock = jest.fn()
    global.fetch = fetchMock as any

    // Search root folder -> duplicates from a historical race
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [
        { id: 'newer-root', createdTime: '2026-02-01T00:00:00Z' },
        { id: 'older-root', createdTime: '2026-01-01T00:00:00Z' },
      ] },
    }))

    // Search sessions folder under the adopted root -> found
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [{ id: 'sessions-folder-id', createdTime: '2026-01-02T00:00:00Z' }] },
    }))

    // List files in sessions folder
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [] },
    }))

    await service.listFiles('sessions')

    // The subfolder search ran against the OLDEST root copy
    expect(fetchMock.mock.calls[1][0]).toContain(encodeURIComponent(`'older-root' in parents`))
  })

  it('adopts the oldest folder when a concurrent create raced ours', async () => {
    const auth = createAuth()
    const service = new GoogleDriveService(auth)

    const fetchMock = jest.fn()
    global.fetch = fetchMock as any

    // Search root folder -> found
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [{ id: 'root-folder-id' }] },
    }))

    // Search sessions folder -> not found
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [] },
    }))

    // Create sessions folder -> ours
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { id: 'mine' },
    }))

    // Post-create re-query -> another device created one first
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [
        { id: 'mine', createdTime: '2026-01-01T00:00:10Z' },
        { id: 'theirs', createdTime: '2026-01-01T00:00:05Z' },
      ] },
    }))

    // List files in sessions folder
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [] },
    }))

    await service.listFiles('sessions')

    // The listing targets the older concurrent copy, not the one we created
    expect(fetchMock.mock.calls[4][0]).toContain('%27theirs%27+in+parents')
  })

  it('throws for unknown backup folders instead of creating an unnamed folder', async () => {
    const auth = createAuth()
    const service = new GoogleDriveService(auth)

    await expect(
      (service as any).createFolderStructure('bogus')
    ).rejects.toThrow('Unknown backup folder: bogus')
  })
})
