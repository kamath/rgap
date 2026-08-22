import { useState } from 'react';
import type { Grant } from '@rgap/core';
import { useRgapClient } from '@rgap/react';
import { Execute, Json, type ExecuteFn } from './panes';

/** `datetime-local` reads and writes wall-clock time, so the instant is converted at each boundary. */
const toLocalInput = (iso: string) => {
  const instant = new Date(iso);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/**
 * Request side of creating a grant. A new grant reaches nothing: what it reaches is set from the
 * grant itself, where the whole capability set is visible at once.
 */
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
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState(parent?.expiresAt ? toLocalInput(parent.expiresAt) : '');

  const input = {
    name,
    capabilities: [] as Grant['capabilities'],
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          const committed = await execute('create', async () => {
            const grant = parent
              ? await (await client.grants.get(parent.id)).create(input)
              : await client.grants.create(input);
            setName('');
            return grant;
          });
          if (committed) onCommitted?.();
        })();
      }}
    >
      <label>
        <span>name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Researcher" />
      </label>
      <label>
        <span>expires at</span>
        <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
      </label>
      {parent?.expiresAt ? <p className="field-note">Must not exceed {parent.expiresAt}.</p> : null}
      <Json
        value={parent
          ? { grant: parent.id, method: 'create', params: input }
          : { method: 'grants.create', params: input }}
      />
      <Execute label="Execute operation" />
    </form>
  );
}
