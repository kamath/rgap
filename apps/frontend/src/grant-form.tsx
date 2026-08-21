import { useState } from 'react';
import { permissions, requireResourceId, type Grant, type Permission, type RelocationPolicy } from '@rgap/core';
import { useRgapClient, useRgapSnapshot } from '@rgap/react';
import { Execute, Json, type ExecuteFn } from './panes';
import { resolvePath } from './tree';

const relocationPolicies: RelocationPolicy[] = ['revoke_on_scope_exit', 'follow_resource', 'deny_move'];

/** `datetime-local` reads and writes wall-clock time, so the instant is converted at each boundary. */
const toLocalInput = (iso: string) => {
  const instant = new Date(iso);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/** Request side of the grant operation: a root grant, or a downscoped child when a parent is given. */
export function GrantFields({
  parent,
  execute,
  onCommitted,
}: {
  parent?: Grant;
  execute: ExecuteFn;
  onCommitted?: () => void;
}) {
  const client = useRgapClient();
  const snapshot = useRgapSnapshot();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<Permission[]>(['invoke']);
  const [descendants, setDescendants] = useState(false);
  const [relocation, setRelocation] = useState<RelocationPolicy>('revoke_on_scope_exit');
  const [expiresAt, setExpiresAt] = useState(parent?.expiresAt ? toLocalInput(parent.expiresAt) : '');

  const resourceId = resolvePath(snapshot.resources, path);
  const input = {
    name,
    subject,
    parentId: parent?.id ?? null,
    capabilities: [{ resourceId, permissions: selected, descendants, relocation }],
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          const committed = await execute('createGrant', async () => {
            const capability = { ...input.capabilities[0], resourceId: requireResourceId(snapshot.resources, path) };
            const grant = await client.createGrant({ ...input, capabilities: [capability] });
            setName('');
            setSubject('');
            return grant;
          });
          if (committed) onCommitted?.();
        })();
      }}
    >
      <div className="field-row">
        <label>
          <span>name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Researcher" />
        </label>
        <label>
          <span>subject</span>
          <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="research sub-agent" />
        </label>
      </div>
      <label>
        <span>resource path</span>
        <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="Acme/MCP servers/Google Drive" />
      </label>
      <div className="checks">
        {permissions.map((permission) => (
          <label key={permission} className="check">
            <input
              type="checkbox"
              checked={selected.includes(permission)}
              onChange={(event) =>
                setSelected(
                  event.target.checked ? [...selected, permission] : selected.filter((item) => item !== permission),
                )
              }
            />
            {permission}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={descendants} onChange={(event) => setDescendants(event.target.checked)} />
          descendants
        </label>
      </div>
      <div className="field-row">
        <label>
          <span>relocation policy</span>
          <select value={relocation} onChange={(event) => setRelocation(event.target.value as RelocationPolicy)}>
            {relocationPolicies.map((policy) => (
              <option key={policy} value={policy}>
                {policy}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>expires at</span>
          <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>
      </div>
      {parent?.expiresAt ? <p className="field-note">Must not exceed {parent.expiresAt}.</p> : null}
      <Json value={{ method: 'createGrant', params: input }} />
      <Execute label="Execute operation" />
    </form>
  );
}
