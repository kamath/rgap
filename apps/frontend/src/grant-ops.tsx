import { useState } from 'react';
import type { Grant, Token } from '@rgap/core';
import { useGrantList, useGrantRecords, useRgapClient } from '@rgap/react';
import { GrantFields } from './grant-form';
import { Drawer, Execute, Form, Json, ResponseBlock, Targets, plural, useOperation } from './panes';
import { usePlane, useShell } from './shell';
import { grantDescendants } from './tree';

export type GrantOperation = 'Create' | 'Set capabilities' | 'Revoke' | 'Issue token' | 'Revoke token';

/** Creating inside the addressed grant is what creating inside the addressed location is in the explorer. */
export function CreateGrantDrawer({ parent, onClose }: { parent: Grant | null; onClose: () => void }) {
  const plane = usePlane();
  const { response, execute } = useOperation();

  return (
    <Drawer label={parent ? 'Create' : 'Create root grant'} meta={`${plane} plane`} onClose={onClose}>
      <GrantFields parent={parent ?? undefined} execute={execute} onCommitted={onClose} />
      <p className="field-note">
        {parent
          ? `The grant is delegated from ${parent.name} and reaches nothing until its capabilities are set.`
          : 'A root grant is delegated from nothing, which is an administrative operation no token authorizes.'}
      </p>
      <ResponseBlock response={response} />
    </Drawer>
  );
}

export function RevokeGrantsDrawer({ targets, onClose }: { targets: Grant[]; onClose: () => void }) {
  const client = useRgapClient();
  const grants = useGrantRecords();
  useGrantList({ limit: 100 });
  const plane = usePlane();
  const { response, executeEach } = useOperation();
  const request = { method: 'revoke', calls: targets.map((target) => ({ grant: target.id })) };
  // Revocation reaches the whole subtree, so the drawer states that extent before the command runs.
  const extent = targets.map((target) => ({ target, descendants: grantDescendants(grants, target.id) }));
  const reached = new Set(extent.flatMap(({ target, descendants }) => [target.id, ...descendants.map((g) => g.id)]));

  const submit = async () => {
    const committed = await executeEach(
      'revoke',
      targets,
      (target) => target.name,
      async (target) => (await client.grants.get(target.id)).revoke(),
    );
    if (committed) onClose();
  };

  return (
    <Drawer label={`Revoke · ${plural(targets.length, 'grant')}`} meta={`${plane} plane`} onClose={onClose}>
      <Form onSubmit={submit}>
        <div className="targets">
          <span className="targets-label">targets · {plural(reached.size, 'grant')} disabled</span>
          {extent.map(({ target, descendants }) => (
            <div key={target.id} className="extent">
              <code>{target.name}</code>
              {descendants.map((descendant) => (
                <code key={descendant.id} className="dim">
                  ↳ {descendant.name}
                </code>
              ))}
            </div>
          ))}
        </div>
        <p className="field-note">
          Revocation disables {targets.length === 1 ? 'this grant' : 'each of these grants'} and every grant delegated
          from it, listed above. Each revocation is its own command.
        </p>
        <Json value={request} />
        <Execute label="Execute operation" />
        <ResponseBlock response={response} />
      </Form>
    </Drawer>
  );
}

export function IssueTokenDrawer({ grant, onClose }: { grant: Grant; onClose: () => void }) {
  const client = useRgapClient();
  const plane = usePlane();
  const { setToken } = useShell();
  const { response, execute } = useOperation();
  const [label, setLabel] = useState('');
  // Only a hash is stored, so the returned value is the only copy there will ever be. The drawer
  // holds it instead of closing on commit, which is what every other operation does.
  const [issued, setIssued] = useState<string | null>(null);

  const submit = async () => {
    await execute('tokens.create', async () => {
      const token = await (await client.grants.get(grant.id)).tokens.create({ label });
      setToken(token.value);
      setIssued(token.value);
      return { id: token.id, grantId: token.grantId, label: token.label, hash: token.hash, value: token.value, activated: true };
    });
  };

  return (
    <Drawer label="Issue token" meta={`${plane} plane`} onClose={onClose}>
      {issued ? (
        <>
          <IssuedToken value={issued} />
          <p className="field-note">
            This value is stored nowhere. Closing this drawer is the last chance to read it. It is the active token
            until the header's control is changed.
          </p>
        </>
      ) : (
        <Form onSubmit={submit}>
          <label>
            <span>grant</span>
            <input value={grant.name} readOnly />
          </label>
          <label>
            <span>label</span>
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="research sub-agent" />
          </label>
          <p className="field-note">The issued bearer value is returned once, activated here, and never stored.</p>
          <Json value={{ grant: grant.id, method: 'tokens.create', params: { label } }} />
          <Execute label="Execute operation" />
        </Form>
      )}
      <ResponseBlock response={response} />
    </Drawer>
  );
}

/** The one-time bearer value, on a line of its own because it is the point of the operation. */
function IssuedToken({ value }: { value: string }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className="issued">
      <div className="issued-head">
        <span className="response-label">bearer value</span>
        <button type="button" className="ghost" onClick={copy}>
          {copied === 'copied' ? 'copied' : copied === 'failed' ? 'copy failed' : 'copy'}
        </button>
      </div>
      <code className="issued-value">{value}</code>
    </div>
  );
}

export function RevokeTokensDrawer({ targets, onClose }: { targets: Token[]; onClose: () => void }) {
  const client = useRgapClient();
  const plane = usePlane();
  const { response, executeEach } = useOperation();
  const request = { method: 'revoke', calls: targets.map((target) => ({ token: target.id })) };

  const submit = async () => {
    const committed = await executeEach(
      'revoke',
      targets,
      (target) => target.label,
      async (target) => (await client.tokens.get(target.id)).revoke(),
    );
    if (committed) onClose();
  };

  return (
    <Drawer label={`Revoke · ${plural(targets.length, 'token')}`} meta={`${plane} plane`} onClose={onClose}>
      <Form onSubmit={submit}>
        <Targets items={targets.map((target) => target.label)} />
        <p className="field-note">
          Revoking a token disables that credential and leaves the grant it references intact. Each revocation is its
          own command.
        </p>
        <Json value={request} />
        <Execute label="Execute operation" />
        <ResponseBlock response={response} />
      </Form>
    </Drawer>
  );
}
