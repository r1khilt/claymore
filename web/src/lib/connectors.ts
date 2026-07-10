import type { Connector, ConnectorStatus, SourcePlatform } from './types'

export const CONNECTOR_PLATFORMS = ['slack', 'gmail', 'github', 'notion'] as const

export type ConnectorPlatform = (typeof CONNECTOR_PLATFORMS)[number]

const NAMES: Record<ConnectorPlatform, string> = {
  slack: 'Slack',
  gmail: 'Gmail',
  github: 'GitHub',
  notion: 'Notion',
}

type JsonRecord = Record<string, unknown>

export class ConnectorApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ConnectorApiError'
    this.status = status
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function stringAt(raw: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function numberAt(raw: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  }
  return undefined
}

function isConnectorPlatform(value: unknown): value is ConnectorPlatform {
  return typeof value === 'string' && CONNECTOR_PLATFORMS.includes(value as ConnectorPlatform)
}

function normalizeStatus(value: unknown, connected: boolean): ConnectorStatus {
  if (typeof value !== 'string') return connected ? 'connected' : 'disconnected'
  switch (value.trim().toLowerCase().replaceAll('-', '_')) {
    case 'active':
    case 'ready':
    case 'connected':
      return 'connected'
    case 'pending':
    case 'authorizing':
    case 'connecting':
      return 'connecting'
    case 'running':
    case 'queued':
    case 'syncing':
      return 'syncing'
    case 'expired':
    case 'requires_reauth':
    case 'reauth_required':
      return 'reauth_required'
    case 'degraded':
    case 'failed':
    case 'error':
      return 'error'
    default:
      return connected ? 'connected' : 'disconnected'
  }
}

function connectorFromJson(value: unknown): Connector | null {
  const raw = record(value)
  if (!raw || !isConnectorPlatform(raw.platform)) return null
  const connected = raw.connected === true
  const syncState = raw.syncStatus ?? raw.sync_status
  const activeSyncState =
    typeof syncState === 'string' &&
    ['queued', 'running', 'syncing', 'failed', 'error'].includes(syncState.toLowerCase())
      ? syncState
      : undefined
  const status = normalizeStatus(
    activeSyncState ?? raw.connectionStatus ?? raw.connection_status ?? raw.status,
    connected,
  )
  return {
    id: stringAt(raw, 'id', 'connectorId', 'connector_id'),
    platform: raw.platform,
    name: stringAt(raw, 'name') ?? NAMES[raw.platform],
    connected: connected || status === 'connected' || status === 'syncing',
    status,
    account: stringAt(raw, 'account', 'accountLabel', 'account_label', 'displayName', 'display_name'),
    lastSync: stringAt(raw, 'lastSync', 'last_sync', 'lastSyncAt', 'last_sync_at'),
    episodes: numberAt(raw, 'episodes', 'episodeCount', 'episode_count', 'indexedEpisodes', 'indexed_episodes'),
    error: stringAt(raw, 'error', 'lastError', 'last_error', 'message'),
  }
}

function defaultConnector(platform: ConnectorPlatform): Connector {
  return {
    platform,
    name: NAMES[platform],
    connected: false,
    status: 'disconnected',
    episodes: 0,
  }
}

function connectorList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const raw = record(value)
  if (!raw) return []
  if (Array.isArray(raw.connectors)) return raw.connectors
  if (Array.isArray(raw.items)) return raw.items
  const keyed = CONNECTOR_PLATFORMS.flatMap((platform) => {
    const item = record(raw[platform])
    return item ? [{ ...item, platform }] : []
  })
  if (keyed.length > 0) return keyed
  return []
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = record(await response.json())
    if (body) return stringAt(body, 'detail', 'message', 'error') ?? `request failed (${response.status})`
  } catch {
    // The status remains the useful fallback for an empty/non-JSON response.
  }
  return `request failed (${response.status})`
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: {
        accept: 'application/json',
        ...init?.headers,
      },
    })
  } catch {
    throw new ConnectorApiError('Could not reach the connector service.', 0)
  }
  if (!response.ok) throw new ConnectorApiError(await responseMessage(response), response.status)
  if (response.status === 204) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function getConnectors(signal?: AbortSignal): Promise<Connector[]> {
  const body = await requestJson('/api/connectors', { signal })
  const received = connectorList(body)
    .map(connectorFromJson)
    .filter((connector): connector is Connector => connector !== null)
  const byPlatform = new Map(received.map((connector) => [connector.platform, connector]))
  return CONNECTOR_PLATFORMS.map((platform) => byPlatform.get(platform) ?? defaultConnector(platform))
}

async function authRequest(platform: ConnectorPlatform, reconnect: boolean): Promise<unknown> {
  const body = JSON.stringify({ reconnect })
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }
  try {
    return await requestJson(`/api/connectors/${encodeURIComponent(platform)}/connect`, init)
  } catch (error) {
    // Accept the alternate noun used by older connector service drafts.
    if (!(error instanceof ConnectorApiError) || ![404, 405].includes(error.status)) throw error
    return requestJson(`/api/connectors/${encodeURIComponent(platform)}/authorize`, init)
  }
}

export async function beginConnectorAuth(
  platform: ConnectorPlatform,
  reconnect = false,
): Promise<string> {
  const raw = record(await authRequest(platform, reconnect))
  const url = raw
    ? stringAt(raw, 'authorizeUrl', 'authorize_url', 'authorizationUrl', 'authorization_url', 'authUrl', 'auth_url', 'url', 'redirectUrl', 'redirect_url')
    : undefined
  if (!url) throw new ConnectorApiError('The connector service did not return an authorization URL.', 502)
  return url
}

export async function syncConnector(platform: ConnectorPlatform): Promise<void> {
  await requestJson(`/api/connectors/${encodeURIComponent(platform)}/sync`, { method: 'POST' })
}

export async function disconnectConnector(platform: ConnectorPlatform): Promise<void> {
  try {
    await requestJson(`/api/connectors/${encodeURIComponent(platform)}`, { method: 'DELETE' })
  } catch (error) {
    if (!(error instanceof ConnectorApiError) || ![404, 405].includes(error.status)) throw error
    await requestJson(`/api/connectors/${encodeURIComponent(platform)}/disconnect`, { method: 'POST' })
  }
}

export type OAuthPopupResult = 'connected' | 'closed' | 'failed' | 'timeout'

interface OAuthMessage {
  type?: string
  platform?: string
  status?: string
}

function oauthMessage(value: unknown): OAuthMessage | null {
  return record(value) as OAuthMessage | null
}

/** Wait for the callback's postMessage while also polling status for hosted OAuth pages. */
export function waitForOAuthPopup(
  popup: Window,
  platform: ConnectorPlatform,
  poll: () => Promise<Connector[]>,
  timeoutMs = 5 * 60_000,
): Promise<OAuthPopupResult> {
  return new Promise((resolve) => {
    let settled = false
    let polling = false
    let closedAt: number | null = null

    const finish = (result: OAuthPopupResult) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      window.clearInterval(timer)
      window.clearTimeout(timeout)
      resolve(result)
    }

    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup) return
      const message = oauthMessage(event.data)
      if (!message || message.platform !== platform) return
      if (!['claymore:connector-oauth', 'connector:oauth', 'connector-oauth'].includes(message.type ?? '')) return
      const status = message.status?.toLowerCase()
      finish(status === 'error' || status === 'failed' ? 'failed' : 'connected')
    }

    window.addEventListener('message', onMessage)
    const timer = window.setInterval(async () => {
      if (popup.closed) {
        closedAt ??= Date.now()
        if (Date.now() - closedAt >= 8_000) {
          finish('closed')
          return
        }
      }
      if (polling) return
      polling = true
      try {
        const connectors = await poll()
        const connector = connectors.find((item) => item.platform === platform)
        if (connector?.connected || connector?.status === 'connected' || connector?.status === 'syncing') {
          if (!popup.closed) popup.close()
          finish('connected')
        } else if (connector?.status === 'error' || connector?.status === 'reauth_required') {
          finish('failed')
        }
      } catch {
        // OAuth may briefly race backend availability; the visible caller handles final errors.
      } finally {
        polling = false
      }
    }, 1_250)
    const timeout = window.setTimeout(() => finish('timeout'), timeoutMs)
  })
}

export function asConnectorPlatform(platform: SourcePlatform): ConnectorPlatform | null {
  return isConnectorPlatform(platform) ? platform : null
}
