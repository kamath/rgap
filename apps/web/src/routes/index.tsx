import type { RgapRequest, RgapResponse } from '@rgap/core'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import { executeRgap } from '../lib/rgap/functions'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const [selectedPreset, setSelectedPreset] = useState(0)
  const [requestText, setRequestText] = useState(() => JSON.stringify(presets[0].request, null, 2))
  const [response, setResponse] = useState<RgapResponse | null>(null)
  const [history, setHistory] = useState<Array<{ method: string; allowed?: boolean; error?: boolean }>>([])
  const [pending, setPending] = useState(false)
  const responseText = useMemo(
    () => response ? JSON.stringify(response, null, 2) : '// The parsed response appears here.',
    [response],
  )

  function choosePreset(index: number) {
    setSelectedPreset(index)
    setRequestText(JSON.stringify(presets[index].request, null, 2))
    setResponse(null)
  }

  async function runRequest() {
    setPending(true)
    try {
      const request = JSON.parse(requestText) as RgapRequest
      const nextResponse = await executeRgap({ data: request })
      setResponse(nextResponse)
      setHistory((current) => [{
        method: request.method,
        allowed: 'result' in nextResponse && typeof nextResponse.result === 'object' &&
          nextResponse.result !== null && 'allowed' in nextResponse.result
          ? Boolean(nextResponse.result.allowed) : undefined,
        error: 'error' in nextResponse,
      }, ...current].slice(0, 5))
    } catch (error) {
      setResponse({
        id: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: error instanceof Error ? error.message : 'Request is not valid JSON',
          details: {},
        },
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="page-shell">
      <header className="masthead">
        <a className="brand" href="/" aria-label="RGAP home">
          <span className="brand-mark">R</span><span>RGAP</span>
        </a>
        <span className="status"><i /> Reference implementation</span>
      </header>

      <section className="hero">
        <p className="eyebrow">Resource Grant Authorization Protocol</p>
        <h1>Delegate access.<br />Never expand it.</h1>
        <p className="lede">A small, inspectable protocol for giving agents authority they can safely narrow and pass to sub-agents.</p>
      </section>

      <section className="principles" aria-label="Protocol concepts">
        <article><span>01</span><h2>Resource tree</h2><p>Stable IDs describe what exists. Parent links describe where it lives now.</p></article>
        <article><span>02</span><h2>Grant tree</h2><p>Every delegation is equal to or narrower than the authority above it.</p></article>
        <article><span>03</span><h2>Opaque tokens</h2><p>Bearer credentials exercise grants without containing the policy itself.</p></article>
      </section>

      <section className="workbench">
        <div className="workbench-head">
          <div><p className="eyebrow">Live protocol workbench</p><h2>Send an operation</h2></div>
          <p>Backed by Drizzle and an embedded PGlite database.</p>
        </div>

        <div className="operation-tabs" role="tablist" aria-label="Example operations">
          {presets.map((preset, index) => (
            <button key={preset.label} className={selectedPreset === index ? 'active' : ''}
              onClick={() => choosePreset(index)} role="tab" aria-selected={selectedPreset === index}>
              {preset.label}
            </button>
          ))}
        </div>

        <div className="console-grid">
          <div className="console-panel">
            <div className="console-label"><span>Request</span><code>POST /api/rgap</code></div>
            <textarea aria-label="RGAP request" spellCheck={false} value={requestText}
              onChange={(event) => setRequestText(event.target.value)} />
            <button className="execute" onClick={runRequest} disabled={pending}>
              {pending ? 'Evaluating…' : 'Execute operation'}<span aria-hidden="true">→</span>
            </button>
          </div>
          <div className="console-panel response-panel">
            <div className="console-label"><span>Response</span><code>Zod validated</code></div>
            <pre>{responseText}</pre>
          </div>
        </div>

        {history.length > 0 && <div className="history">
          <span>Recent</span>
          {history.map((item, index) => <div key={`${item.method}-${index}`}>
            <i className={item.error || item.allowed === false ? 'denied' : ''} /><code>{item.method}</code>
          </div>)}
        </div>}
      </section>

      <section className="invariant">
        <p className="eyebrow">The invariant</p>
        <blockquote>Authority may only stay the same or become narrower as it is delegated.</blockquote>
        <div className="scope-flow" aria-label="Delegation narrows from human to agent to sub-agent">
          <span>Human <small>all MCP servers</small></span><b>→</b>
          <span>Agent <small>GitHub · Slack</small></span><b>→</b>
          <span>Sub-agent <small>GitHub read</small></span>
        </div>
      </section>

      <footer><span>MIT licensed</span><span>Protocol first · implementation included</span></footer>
    </main>
  )
}

const presets: Array<{ label: string; request: RgapRequest }> = [
  { label: 'Create resource', request: { id: '01', method: 'resource.create', params: {
    id: 'mcp-github', parent_resource_id: null, name: 'GitHub MCP server', type: 'mcp-server',
    move_policy: 'normal', delete_policy: 'revoke',
  } } },
  { label: 'Create grant', request: { id: '02', method: 'grant.create', params: {
    id: 'grant-human', capabilities: [{ resource_id: 'mcp-github', permissions: ['tools/read', 'tools/call'],
      constraints: {}, descendant_policy: 'include', relocation_policy: 'follow_resource' }],
    expires_at: null, created_by: 'human',
  } } },
  { label: 'Delegate', request: { id: '03', method: 'grant.delegate', params: {
    id: 'grant-agent', parent_grant_id: 'grant-human', capabilities: [{ resource_id: 'mcp-github',
      permissions: ['tools/read'], constraints: {}, descendant_policy: 'include', relocation_policy: 'revoke_on_scope_exit' }],
    expires_at: null, created_by: 'agent',
  } } },
  { label: 'Issue token', request: { id: '04', method: 'token.issue', params: {
    id: 'token-agent', grant_id: 'grant-agent', expires_at: null, actor: 'human',
  } } },
  { label: 'Authorize', request: { id: '05', method: 'authorize', params: {
    token: 'paste_the_issued_token_here', resource_id: 'mcp-github', permission: 'tools/read', constraints: {},
  } } },
  { label: 'Revoke grant', request: { id: '06', method: 'grant.revoke', params: {
    grant_id: 'grant-human', actor: 'human',
  } } },
]
