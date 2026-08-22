import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { permissions, RgapError, tokenValue, type Permission } from '@rgap/core';
import { useResolvedPath, useRgapClient } from '@rgap/react';
import { Execute, Json, Pane, PageTitle, ResponsePane, useOperation } from '../panes';
import { useShell } from '../shell';

export const Route = createFileRoute('/authorize')({ component: Authorize });

function Authorize() {
  const client = useRgapClient();
  const { token: activeToken } = useShell();
  const { response, execute } = useOperation();
  const [token, setToken] = useState('');
  const [path, setPath] = useState('');
  const [permission, setPermission] = useState<Permission>('invoke');
  const bearer = token || activeToken;
  const { resourceId } = useResolvedPath(path);

  return (
    <>
      <PageTitle title="Send an operation" note="Authorization decided by the pure rules in @rgap/core." />
      <div className="pane-row">
        <Pane label="Request" meta="decision · authorize">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void execute('authorize', () => {
                if (!resourceId) throw new RgapError('missing_resource', 'Resource does not exist.');
                return client.authorize(tokenValue(bearer), resourceId, permission);
              });
            }}
          >
            <label>
              <span>token</span>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={activeToken ? 'empty to use the active token' : 'rgap_…'}
              />
            </label>
            <label>
              <span>resource path</span>
              <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="Acme/MCP servers" />
            </label>
            <label>
              <span>permission</span>
              <select value={permission} onChange={(event) => setPermission(event.target.value as Permission)}>
                {permissions.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <Json
              value={{
                method: 'authorize',
                params: { token: bearer ? `${bearer.slice(0, 12)}…` : null, resourceId, permission },
              }}
            />
            <Execute label="Execute operation" />
          </form>
        </Pane>
        <ResponsePane response={response} />
      </div>
    </>
  );
}
