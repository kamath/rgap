import { useState } from 'react';
import type { Grant, Token } from '@rgap/core';
import { useRgapClient } from '@rgap/react';
import { GrantFields } from './grant-form';
import { Drawer, Execute, Form, Json, ResponseBlock, Targets, plural, useOperation } from './panes';
import { usePlane, useShell } from './shell';

export type GrantOperation = 'Delegate' | 'Revoke' | 'Issue token' | 'Revoke token';

/** Delegating from the addressed grant is what creating inside the addressed location is in the explorer. */
export function DelegateDrawer({ parent, onClose }: { parent: Grant | null; onClose: () => void }) {
  const plane = usePlane();
  const { response, execute } = useOperation();

  return (
    <Drawer label={parent ? 'Delegate' : 'Create root grant'} meta={`${plane} plane`} onClose={onClose}>
      <GrantFields parent={parent ?? undefined} execute={execute} onCommitted={onClose} />
      <p className="field-note">
        {parent
          ? `The child grant is delegated from ${parent.name} and may only downscope its authority.`
          : 'A root grant is delegated from nothing, which is an administrative operation no token authorizes.'}
      </p>
      <ResponseBlock response={response} />
    </Drawer>
  );
}

export function RevokeGrantsDrawer({ targets, onClose }: { targets: Grant[]; onClose: () => void }) {
  const client = useRgapClient();
  const plane = usePlane();
  const { response, executeEach } = useOperation();
  const request = { method: 'revokeGrant', calls: targets.map((target) => ({ id: target.id })) };

  const submit = async () => {
    const committed = await executeEach(
      'revokeGrant',
      targets,
      (target) => target.name,
      (target) => client.revokeGrant(target.id),
    );
    if (committed) onClose();
  };

  return (
    <Drawer label={`Revoke · ${plural(targets.length, 'grant')}`} meta={`${plane} plane`} onClose={onClose}>
      <Form onSubmit={submit}>
        <Targets items={targets.map((target) => target.name)} />
        <p className="field-note">
          Revocation disables {targets.length === 1 ? 'this grant' : 'each of these grants'} and every grant delegated
          from it. Each revocation is its own command.
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

  const submit = async () => {
    const committed = await execute('issueToken', async () => {
      const token = await client.issueToken(grant.id, label);
      setToken(token.value);
      return { record: token.record, value: token.value, activated: true };
    });
    if (committed) onClose();
  };

  return (
    <Drawer label="Issue token" meta={`${plane} plane`} onClose={onClose}>
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
        <Json value={{ method: 'issueToken', params: { grantId: grant.id, label } }} />
        <Execute label="Execute operation" />
        <ResponseBlock response={response} />
      </Form>
    </Drawer>
  );
}

export function RevokeTokensDrawer({ targets, onClose }: { targets: Token[]; onClose: () => void }) {
  const client = useRgapClient();
  const plane = usePlane();
  const { response, executeEach } = useOperation();
  const request = { method: 'revokeToken', calls: targets.map((target) => ({ id: target.id })) };

  const submit = async () => {
    const committed = await executeEach(
      'revokeToken',
      targets,
      (target) => target.label,
      (target) => client.revokeToken(target.id),
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
