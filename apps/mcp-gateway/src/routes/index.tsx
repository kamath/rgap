import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { authClient } from '../auth-client'
import type { Connection } from '../shared/connections'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const session = authClient.useSession()
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')

  if (session.isPending) {
    return <main className="centered">Loading gateway…</main>
  }

  if (!session.data) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">RGAP</p>
          <h1>MCP Gateway</h1>
          <p className="lede">
            Connect authenticated MCP servers without exposing upstream
            credentials or the RGAP command plane.
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault()
              setAuthError('')
              const result =
                mode === 'sign-in'
                  ? await authClient.signIn.email({ email, password })
                  : await authClient.signUp.email({
                      email,
                      password,
                      name: email.split('@')[0] || 'Gateway user',
                    })
              if (result.error) {
                setAuthError(result.error.message ?? 'Authentication failed.')
              } else {
                await session.refetch()
              }
            }}
          >
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={
                  mode === 'sign-in' ? 'current-password' : 'new-password'
                }
                minLength={8}
                required
              />
            </label>
            {authError ? <p className="error">{authError}</p> : null}
            <button type="submit">
              {mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <button
            className="text-button"
            type="button"
            onClick={() =>
              setMode((current) =>
                current === 'sign-in' ? 'sign-up' : 'sign-in',
              )
            }
          >
            {mode === 'sign-in'
              ? 'Create an account'
              : 'Use an existing account'}
          </button>
        </section>
      </main>
    )
  }

  return (
    <Dashboard
      user={session.data.user}
      onSignOut={async () => {
        await authClient.signOut()
        await session.refetch()
      }}
    />
  )
}

function Dashboard({
  user,
  onSignOut,
}: {
  user: { name: string; email: string }
  onSignOut: () => Promise<void>
}) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [displayName, setDisplayName] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tokenPassword, setTokenPassword] = useState('')
  const [mcpToken, setMcpToken] = useState('')

  const load = useCallback(async () => {
    const response = await fetch('/api/connections')
    if (!response.ok) throw new Error('Unable to load connections.')
    const body = (await response.json()) as { connections: Connection[] }
    setConnections(body.connections)
  }, [])

  const refreshAfterAuthorization = useCallback(() => {
    for (const delay of [2_000, 5_000, 10_000, 20_000]) {
      window.setTimeout(() => load().catch(() => undefined), delay)
    }
  }, [load])

  const openAuthorization = useCallback(
    (authorizationUrl: string) => {
      window.open(
        authorizationUrl,
        'mcp-authorization',
        'popup,width=720,height=760',
      )
      refreshAfterAuthorization()
    },
    [refreshAfterAuthorization],
  )

  useEffect(() => {
    load().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : 'Request failed.'),
    )
  }, [load])

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <p className="eyebrow">RGAP</p>
          <h1>MCP Gateway</h1>
        </div>
        <div className="account">
          <span>{user.email}</span>
          <button className="secondary" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {error ? <p className="error banner">{error}</p> : null}

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Connections</h2>
            <p>Authorize an upstream MCP server for your account.</p>
          </div>
          <span className="count">{connections.length}</span>
        </div>

        <form
          className="connection-form"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            setError('')
            try {
              const response = await fetch('/api/connections', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ displayName, serverUrl }),
              })
              const body = (await response.json()) as Connection & {
                error?: string
              }
              if (!response.ok) {
                throw new Error(body.error ?? 'Unable to create connection.')
              }
              setDisplayName('')
              setServerUrl('')
              await load()
              if (body.authorizationUrl) {
                openAuthorization(body.authorizationUrl)
              }
            } catch (cause) {
              setError(
                cause instanceof Error ? cause.message : 'Request failed.',
              )
            } finally {
              setBusy(false)
            }
          }}
        >
          <label>
            Name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="GitHub"
              maxLength={80}
              required
            />
          </label>
          <label className="grow">
            MCP server URL
            <input
              type="url"
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://mcp.example.com"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? 'Connecting…' : 'Add connection'}
          </button>
        </form>

        <div className="connection-list">
          {connections.length ? (
            connections.map((connection) => (
              <article className="connection" key={connection.id}>
                <div className="connection-copy">
                  <div className="connection-title">
                    <h3>{connection.displayName}</h3>
                    <span className={`status ${connection.status}`}>
                      {connection.status.replace('_', ' ')}
                    </span>
                  </div>
                  <p>{connection.serverUrl}</p>
                  <code>/mcp/{connection.id}</code>
                </div>
                <div className="actions">
                  {connection.authorizationUrl ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const response = await fetch(
                          `/api/connections/${connection.id}/authorize`,
                          { method: 'POST' },
                        )
                        const updated = (await response.json()) as Connection & {
                          error?: string
                        }
                        if (!response.ok || !updated.authorizationUrl) {
                          setError(
                            updated.error ??
                              'Unable to start MCP authorization.',
                          )
                          return
                        }
                        openAuthorization(updated.authorizationUrl)
                      }}
                    >
                      Authorize
                    </button>
                  ) : null}
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => load().catch(() => undefined)}
                  >
                    Refresh
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={async () => {
                      if (!window.confirm('Delete this MCP connection?')) return
                      const response = await fetch(
                        `/api/connections/${connection.id}`,
                        {
                          method: 'DELETE',
                        },
                      )
                      if (!response.ok) {
                        const body = (await response.json()) as {
                          error?: string
                        }
                        setError(body.error ?? 'Unable to delete connection.')
                        return
                      }
                      await load()
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="empty">No MCP connections yet.</div>
          )}
        </div>
      </section>

      <section className="panel token-panel">
        <div>
          <h2>MCP client token</h2>
          <p>
            Create a Better Auth bearer session for a non-browser MCP client.
            The token is shown once.
          </p>
        </div>
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            setError('')
            let token = ''
            const result = await authClient.signIn.email(
              { email: user.email, password: tokenPassword },
              {
                onSuccess(context) {
                  token =
                    context.response.headers.get('set-auth-token') ?? ''
                },
              },
            )
            if (result.error || !token) {
              setError(
                result.error?.message ?? 'Unable to create an MCP token.',
              )
              return
            }
            setMcpToken(token)
            setTokenPassword('')
          }}
        >
          <label>
            Confirm password
            <input
              type="password"
              value={tokenPassword}
              onChange={(event) => setTokenPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit">Create token</button>
        </form>
        {mcpToken ? (
          <div className="token-result">
            <code>{mcpToken}</code>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(mcpToken)}
            >
              Copy
            </button>
          </div>
        ) : null}
      </section>
    </main>
  )
}
