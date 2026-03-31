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

    // List files in sessions folder
    fetchMock.mockResolvedValueOnce(createResponse({
      json: { files: [] },
    }))

    await service.listFiles('sessions')

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[2][1]?.method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string)).toMatchObject({
      name: 'sessions',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root-folder-id'],
    })
  })

  it('throws for unknown backup folders instead of creating an unnamed folder', async () => {
    const auth = createAuth()
    const service = new GoogleDriveService(auth)

    await expect(
      (service as any).createFolderStructure('bogus')
    ).rejects.toThrow('Unknown backup folder: bogus')
  })
})
