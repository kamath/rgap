import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useRgapClient, useRgapSnapshot } from '@rgap/react';
import { GrantFields } from '../grant-form';
import { Execute, Json, Pane, PageTitle, ResponsePane, Tabs, useOperation, type ExecuteFn } from '../panes';
import { usePlane, useShell } from '../shell';
import { isLive } from '@rgap/core';
import { grantLineage, grantStatus, isActive, pathOf } from '../tree';

export const Route = createFileRoute('/grants/$grantId')({ component: GrantDetail });

const operations = ['Delegate', 'Issue token', 'Revoke grant'] as const;
type Operation = (typeof operations)[number];

function GrantDetail() {
  const { grantId } = Route.useParams();
  const snapshot = useRgapSnapshot();
  const client = useRgapClient();
  const { response, execute } = useOperation();
  const grant = snapshot.grants[grantId];

  if (!grant) {
    return (
      <p className="empty">
        Grant <code>{grantId}</code> does not exist. <Link to="/grants">Back to the grant tree.</Link>
      </p>
    );
  }

  const lineage = grantLineage(snapshot.grants, grant.id);
  const tokens = Object.values(snapshot.tokens).filter((token) => token.grantId === grant.id);

  return (
    <>
      <PageTitle title={grant.name} note={`Delegation lineage: ${lineage.map((item) => item.name).join(' → ')}`} />
      <div className="pane-row">
        <Pane label="Grant" meta={grant.id}>
          <dl>
            <dt>subject</dt>
            <dd>
              <code>{grant.subject}</code>
            </dd>
            <dt>parent</dt>
            <dd>
              {grant.parentId ? (
                <Link to="/grants/$grantId" params={{ grantId: grant.parentId }}>
                  {snapshot.grants[grant.parentId]?.name ?? grant.parentId}
                </Link>
              ) : (
                <code>root grant</code>
              )}
            </dd>
            <dt>expires</dt>
            <dd>
              <code>{grant.expiresAt ?? 'never'}</code>
            </dd>
            <dt>status</dt>
            <dd className={grantStatus(grant) === 'active' ? 'allowed' : 'denied'}>
              <code>{grantStatus(grant)}</code>
            </dd>
          </dl>
        </Pane>
        <Pane label="Capabilities" meta={`${grant.capabilities.length} entries`}>
          <table>
            <thead>
              <tr>
                <th>Resource</th>
                <th>Permissions</th>
                <th>Descendants</th>
                <th>Relocation</th>
              </tr>
            </thead>
            <tbody>
              {grant.capabilities.map((capability, index) => (
                <tr key={`${capability.resourceId}-${index}`}>
                  <td>
                    {isLive(snapshot.resources[capability.resourceId]) ? (
                      <Link to="/browse/$" params={{ _splat: pathOf(snapshot.resources, capability.resourceId) }}>
                        {pathOf(snapshot.resources, capability.resourceId)}
                      </Link>
                    ) : (
                      <>
                        <code>{pathOf(snapshot.resources, capability.resourceId)}</code>{' '}
                        <code className="denied">deleted</code>
                      </>
                    )}
                  </td>
                  <td>
                    <code>{capability.permissions.join(' ')}</code>
                  </td>
                  <td>
                    <code>{capability.descendants ? 'include' : 'root only'}</code>
                  </td>
                  <td>
                    <code>{capability.relocation}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Pane>
      </div>
      <div className="pane-row single">
        <Pane label="Tokens" meta={`${tokens.length} issued`}>
          {tokens.map((token) => (
            <div className="record" key={token.id}>
              <span>{token.label}</span>
              <code className={isActive(token) ? 'allowed' : 'denied'}>
                {token.revokedAt ? 'revoked' : isActive(token) ? 'active' : 'expired'}
              </code>
              <code className="dim">{token.hash.slice(0, 16)}…</code>
              <button
                type="button"
                className="ghost"
                disabled={Boolean(token.revokedAt)}
                onClick={() => void execute('revokeToken', () => client.revokeToken(token.id))}
              >
                Revoke token
              </button>
            </div>
          ))}
          {tokens.length ? null : <p className="empty">No tokens reference this grant.</p>}
        </Pane>
      </div>
      <div className="pane-row">
        <GrantOperations key={grant.id} grantId={grant.id} execute={execute} />
        <ResponsePane response={response} />
      </div>
    </>
  );
}

function GrantOperations({ grantId, execute }: { grantId: string; execute: ExecuteFn }) {
  const client = useRgapClient();
  const snapshot = useRgapSnapshot();
  const { setToken } = useShell();
  const plane = usePlane();
  const [operation, setOperation] = useState<Operation>('Delegate');
  const [label, setLabel] = useState('');
  const grant = snapshot.grants[grantId];

  const method = operation === 'Delegate' ? 'createGrant' : operation === 'Issue token' ? 'issueToken' : 'revokeGrant';

  return (
    <Pane
      head={<Tabs options={operations} value={operation} onChange={setOperation} />}
      meta={`${plane} plane · ${method}`}
    >
      {operation === 'Delegate' ? (
        <GrantFields parent={grant} execute={execute} />
      ) : operation === 'Issue token' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void execute('issueToken', async () => {
              const token = await client.issueToken(grantId, label);
              setToken(token.value);
              setLabel('');
              return { record: token.record, value: token.value, activated: true };
            });
          }}
        >
          <label>
            <span>label</span>
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="research sub-agent" />
          </label>
          <p className="field-note">The issued bearer value is returned once, activated here, and never stored.</p>
          <Json value={{ method: 'issueToken', params: { grantId, label } }} />
          <Execute label="Execute operation" />
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void execute('revokeGrant', () => client.revokeGrant(grantId));
          }}
        >
          <p className="field-note">Revocation disables this grant and every grant delegated from it.</p>
          <Json value={{ method: 'revokeGrant', params: { id: grantId } }} />
          <Execute label="Execute operation" />
        </form>
      )}
    </Pane>
  );
}
