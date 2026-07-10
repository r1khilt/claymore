import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  Unplug,
} from 'lucide-react'
import { isLive } from '@/lib/api'
import {
  asConnectorPlatform,
  beginConnectorAuth,
  disconnectConnector,
  getConnectors,
  syncConnector,
  waitForOAuthPopup,
  type ConnectorPlatform,
} from '@/lib/connectors'
import { connectors as mockConnectors } from '@/lib/mockData'
import { PlatformIcon } from '@/lib/sources'
import type { Connector, ConnectorStatus } from '@/lib/types'
import { timeAgo } from '@/lib/utils'
import { ViewShell } from './ViewShell'

type Operation = 'connect' | 'sync' | 'disconnect'

const POLL_MS = 1_500

const STATUS_COPY: Record<ConnectorStatus, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting',
  connected: 'Connected',
  syncing: 'Syncing',
  reauth_required: 'Reconnect required',
  error: 'Needs attention',
}

function statusOf(connector: Connector, operation?: Operation): ConnectorStatus {
  if (operation === 'connect') return 'connecting'
  if (operation === 'sync') return 'syncing'
  return connector.status ?? (connector.connected ? 'connected' : 'disconnected')
}

function syncedLabel(iso?: string): string {
  if (!iso) return 'Never synced'
  const relative = timeAgo(iso)
  return relative === 'just now' ? relative : `${relative} ago`
}

function StatusBadge({ status }: { status: ConnectorStatus }) {
  if (status === 'connecting' || status === 'syncing') {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-sage-500/14 px-2 py-1 text-[11.5px] font-medium text-sage-700">
        <Loader2 className="size-3 animate-spin" strokeWidth={2.5} />
        {STATUS_COPY[status]}
      </span>
    )
  }
  if (status === 'connected') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-sage-500/14 px-2 py-1 text-[11.5px] font-medium text-sage-700">
        <Check className="size-3" strokeWidth={2.5} />
        Connected
      </span>
    )
  }
  if (status === 'reauth_required' || status === 'error') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-amber-400/18 px-2 py-1 text-[11.5px] font-medium text-amber-600">
        <AlertTriangle className="size-3" strokeWidth={2.25} />
        {STATUS_COPY[status]}
      </span>
    )
  }
  return <span className="text-[11.5px] font-medium text-faint">Not connected</span>
}

function SmallButton({
  children,
  onClick,
  disabled = false,
  danger = false,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        danger
          ? 'border-clay-500/20 bg-clay-500/[0.06] text-clay-500 hover:bg-clay-500/10'
          : 'border-black/[0.08] bg-white/50 text-muted hover:bg-white/75 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function ConnectorCard({
  connector,
  operation,
  error,
  interactive,
  onConnect,
  onSync,
  onDisconnect,
}: {
  connector: Connector
  operation?: Operation
  error?: string
  interactive: boolean
  onConnect: (reconnect: boolean) => void
  onSync: () => void
  onDisconnect: () => void
}) {
  const status = statusOf(connector, operation)
  const busy = operation !== undefined || status === 'connecting' || status === 'syncing'
  const reauth = status === 'reauth_required'
  const hasConnection = connector.connected || status === 'connected' || status === 'syncing'
  const canSync = hasConnection && !reauth
  const message = error ?? connector.error

  return (
    <div className="glass flex flex-col rounded-2xl p-4">
      <div className="flex items-center gap-3">
        <PlatformIcon platform={connector.platform} size={38} />
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold text-ink">{connector.name}</div>
          <div className="truncate text-[12px] text-faint">
            {connector.account ?? (reauth ? 'Authorization expired' : 'Not connected')}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {message && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-400/10 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} />
          <span>{message}</span>
        </div>
      )}

      {hasConnection && (
        <div className="mt-3.5 flex items-center justify-between border-t border-line/70 pt-3 text-[12px] text-muted">
          <span>
            <span className="font-medium text-ink/80">{(connector.episodes ?? 0).toLocaleString()}</span>{' '}
            episodes
          </span>
          <span className="text-faint">{syncedLabel(connector.lastSync)}</span>
        </div>
      )}

      {interactive && (
        <div className={`flex items-center gap-2 ${hasConnection || message ? 'mt-3' : 'mt-4'}`}>
          {!hasConnection && !reauth && status !== 'error' && (
            <SmallButton onClick={() => onConnect(false)} disabled={busy}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              Connect
            </SmallButton>
          )}
          {(reauth || (status === 'error' && !hasConnection)) && (
            <SmallButton onClick={() => onConnect(true)} disabled={busy}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
              Reconnect
            </SmallButton>
          )}
          {canSync && (
            <>
              <SmallButton onClick={onSync} disabled={busy}>
                {status === 'syncing' ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {status === 'syncing' ? 'Syncing' : status === 'error' ? 'Retry sync' : 'Sync now'}
              </SmallButton>
              <SmallButton onClick={onDisconnect} disabled={busy} danger>
                <Unplug className="size-3" />
                Disconnect
              </SmallButton>
            </>
          )}
          {reauth && hasConnection && (
            <SmallButton onClick={onDisconnect} disabled={busy} danger>
              <Unplug className="size-3" />
              Disconnect
            </SmallButton>
          )}
        </div>
      )}
    </div>
  )
}

export function ConnectorsView() {
  const [connectors, setConnectors] = useState<Connector[]>(isLive ? [] : mockConnectors)
  const [loading, setLoading] = useState(isLive)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [operations, setOperations] = useState<Partial<Record<ConnectorPlatform, Operation>>>({})
  const [errors, setErrors] = useState<Partial<Record<ConnectorPlatform, string>>>({})

  const refresh = useCallback(async (silent = false, signal?: AbortSignal) => {
    if (!isLive) return mockConnectors
    if (!silent) setLoading(true)
    try {
      const next = await getConnectors(signal)
      setConnectors(next)
      setLoadError(null)
      return next
    } catch (error) {
      if (signal?.aborted) return []
      setLoadError(error instanceof Error ? error.message : 'Could not load connectors.')
      return []
    } finally {
      if (!silent && !signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isLive) return
    const controller = new AbortController()
    void refresh(false, controller.signal)
    return () => controller.abort()
  }, [refresh])

  const hasActiveSync = connectors.some((connector) => {
    const platform = asConnectorPlatform(connector.platform)
    return connector.status === 'syncing' || (platform !== null && operations[platform] === 'sync')
  })

  useEffect(() => {
    if (!isLive || !hasActiveSync) return
    const timer = window.setInterval(() => void refresh(true), POLL_MS)
    return () => window.clearInterval(timer)
  }, [hasActiveSync, refresh])

  function startOperation(platform: ConnectorPlatform, operation: Operation) {
    setOperations((current) => ({ ...current, [platform]: operation }))
    setErrors((current) => ({ ...current, [platform]: undefined }))
  }

  function finishOperation(platform: ConnectorPlatform) {
    setOperations((current) => ({ ...current, [platform]: undefined }))
  }

  function failOperation(platform: ConnectorPlatform, error: unknown, fallback: string) {
    setErrors((current) => ({
      ...current,
      [platform]: error instanceof Error ? error.message : fallback,
    }))
  }

  async function connect(platform: ConnectorPlatform, reconnect: boolean) {
    const popup = window.open(
      'about:blank',
      `claymore-${platform}-oauth`,
      'popup=yes,width=620,height=760,resizable=yes,scrollbars=yes',
    )
    if (!popup) {
      failOperation(platform, null, 'Popups are blocked. Allow popups for Claymore and try again.')
      return
    }
    startOperation(platform, 'connect')
    try {
      const authorizeUrl = new URL(await beginConnectorAuth(platform, reconnect), window.location.origin)
      if (!['http:', 'https:'].includes(authorizeUrl.protocol)) {
        throw new Error('The connector service returned an invalid authorization URL.')
      }
      popup.location.replace(authorizeUrl.toString())
      const result = await waitForOAuthPopup(popup, platform, () => refresh(true))
      const next = await refresh(true)
      const connected = next.some(
        (connector) =>
          connector.platform === platform &&
          (connector.connected || connector.status === 'connected' || connector.status === 'syncing'),
      )
      if (!connected) {
        if (result === 'connected') {
          // The callback can post just before its connection transaction becomes visible.
          window.setTimeout(() => void refresh(true), POLL_MS)
          return
        }
        const message =
          result === 'timeout'
            ? 'Connection timed out. Try connecting again.'
            : result === 'failed'
              ? 'Authorization was not completed. Reconnect to try again.'
              : 'Connection window closed before authorization completed.'
        failOperation(platform, null, message)
      }
    } catch (error) {
      failOperation(platform, error, 'Could not start authorization.')
    } finally {
      if (!popup.closed) popup.close()
      finishOperation(platform)
    }
  }

  async function sync(platform: ConnectorPlatform) {
    startOperation(platform, 'sync')
    try {
      await syncConnector(platform)
      setConnectors((current) =>
        current.map((connector) =>
          connector.platform === platform ? { ...connector, status: 'syncing' } : connector,
        ),
      )
    } catch (error) {
      failOperation(platform, error, 'Could not start the sync.')
      finishOperation(platform)
    }
  }

  async function disconnect(platform: ConnectorPlatform, name: string) {
    if (!window.confirm(`Disconnect ${name}? New data will stop syncing.`)) return
    startOperation(platform, 'disconnect')
    try {
      await disconnectConnector(platform)
      await refresh(true)
    } catch (error) {
      failOperation(platform, error, 'Could not disconnect this source.')
    } finally {
      finishOperation(platform)
    }
  }

  // A server-reported terminal state closes the optimistic sync operation and leaves polling.
  useEffect(() => {
    setOperations((current) => {
      let changed = false
      const next = { ...current }
      for (const connector of connectors) {
        const platform = asConnectorPlatform(connector.platform)
        if (platform && current[platform] === 'sync' && connector.status !== 'syncing') {
          next[platform] = undefined
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [connectors])

  const connected = useMemo(() => connectors.filter((connector) => connector.connected), [connectors])
  const total = connected.reduce((sum, connector) => sum + (connector.episodes ?? 0), 0)

  return (
    <ViewShell
      title="Connectors"
      subtitle={
        isLive
          ? 'Managed OAuth via Composio. Connect a source, then sync it into attributed lab memory.'
          : 'Demo connector data. Enable the live API to connect and sync real sources.'
      }
      action={
        <div className="text-right">
          <div className="font-serif text-[28px] leading-none text-sage-600">
            {loading ? '—' : total.toLocaleString()}
          </div>
          <div className="mt-1 text-[12px] text-faint">
            {isLive ? 'episodes in memory' : 'demo episodes'}
          </div>
        </div>
      }
    >
      {loadError && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-[13px] text-amber-700">
          <AlertTriangle className="size-4 shrink-0" strokeWidth={2.25} />
          <span className="flex-1">{loadError}</span>
          <SmallButton onClick={() => void refresh()}>
            <RefreshCw className="size-3" />
            Retry
          </SmallButton>
        </div>
      )}

      {loading && connectors.length === 0 ? (
        <div className="glass flex min-h-40 items-center justify-center gap-2 rounded-2xl text-[13px] text-muted">
          <Loader2 className="size-4 animate-spin text-sage-500" />
          Loading connectors…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {connectors.map((connector) => {
            const platform = asConnectorPlatform(connector.platform)
            return (
              <ConnectorCard
                key={connector.platform}
                connector={connector}
                operation={platform ? operations[platform] : undefined}
                error={platform ? errors[platform] : undefined}
                interactive={isLive && platform !== null}
                onConnect={(reconnect) => platform && void connect(platform, reconnect)}
                onSync={() => platform && void sync(platform)}
                onDisconnect={() => platform && void disconnect(platform, connector.name)}
              />
            )
          })}
        </div>
      )}
    </ViewShell>
  )
}
