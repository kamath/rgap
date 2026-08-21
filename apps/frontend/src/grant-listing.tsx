import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { Capability, Grant, State, Token } from '@rgap/core';
import type { GrantOperation } from './grant-ops';
import { Action, Actions, Check, Pane, type useSelection } from './panes';
import { capabilityLabel, capabilityTarget, grantStatus, isActive, lineageStatus } from './tree';

type Selection<T extends { id: string }> = ReturnType<typeof useSelection<T>>;

/** The delegation lineage, walked the way the resource breadcrumb walks a path. */
export function GrantBreadcrumb({ lineage, trailing }: { lineage: Grant[]; trailing?: string }) {
  return (
    <p className="breadcrumb">
      <Link to="/grants">grants</Link>
      {lineage.map((grant) => (
        <span key={grant.id}>
          <span className="dim"> / </span>
          <Link to="/grants/$grantId" params={{ grantId: grant.id }}>
            {grant.name}
          </Link>
        </span>
      ))}
      {trailing ? (
        <span>
          <span className="dim"> / </span>
          {trailing}
        </span>
      ) : null}
    </p>
  );
}

/** What a capability entry reaches. ID targets retain identity; path targets retain location. */
export function CapabilityResource({
  resources,
  capability,
}: {
  resources: State['resources'];
  capability: Capability;
}) {
  const target = capabilityTarget(resources, capability);

  if (target.state === 'live') {
    return (
      <Link to="/browse/$" params={{ _splat: target.path }}>
        {target.value}
      </Link>
    );
  }
  if (target.state === 'deleted') {
    return (
      <>
        <code>{target.value}</code> <code className="dim">{target.path}</code> <code className="denied">deleted</code>
      </>
    );
  }
  if (target.state === 'empty') {
    return (
      <>
        <code>{target.value}</code> <code className="denied">empty</code>
      </>
    );
  }
  return (
    <>
      <code>{target.value}</code> <code className="denied">unresolved</code>
    </>
  );
}

/**
 * The grants delegated from the addressed grant, or the root grants at the grant list. It lists one
 * record's contents the way the resource explorer does; a grant in full is one link away.
 */
export function GrantListing({
  label,
  meta,
  listing,
  grants,
  resources,
  selection,
  inspect,
  open,
  onOpen,
  up,
  empty,
}: {
  label: string;
  meta: string;
  listing: Grant[];
  grants: State['grants'];
  resources: State['resources'];
  selection: Selection<Grant>;
  /** The addressed grant, which `Inspect` navigates to. The grant list addresses none. */
  inspect: string | null;
  open: GrantOperation | null;
  onOpen: (operation: GrantOperation) => void;
  up?: ReactNode;
  empty: string;
}) {
  const targets = selection.targets;

  return (
    <Pane
      head={
        <>
          <span className="pane-label">{label}</span>
          <Actions>
            <Action label="Create" open={open === 'Create'} onClick={() => onOpen('Create')} />
            <Action
              label="Revoke"
              count={targets.length}
              open={open === 'Revoke'}
              disabled={!targets.length}
              onClick={() => onOpen('Revoke')}
            />
            {inspect ? (
              <Link to="/grants/$grantId/inspect" params={{ grantId: inspect }} className="action">
                Inspect
              </Link>
            ) : null}
          </Actions>
        </>
      }
      meta={meta}
    >
      <table>
        <thead>
          <tr>
            <th className="check-cell">
              <Check
                label="Select every grant"
                disabled={!listing.length}
                checked={selection.allChecked}
                onChange={selection.toggleAll}
              />
            </th>
            <th>Grant</th>
            <th>Subject</th>
            <th>Capabilities</th>
            <th>Expires</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {up ? (
            <tr className="up">
              <td />
              <td colSpan={5}>{up}</td>
            </tr>
          ) : null}
          {listing.map((grant) => {
            const status = lineageStatus(grants, grant.id);

            return (
              <tr
                key={grant.id}
                className={selection.isChecked(grant.id) ? 'selected' : undefined}
                onClick={() => selection.toggle(grant.id)}
              >
                <td className="check-cell">
                  <Check
                    label={`Select ${grant.name}`}
                    checked={selection.isChecked(grant.id)}
                    onChange={() => selection.toggle(grant.id)}
                  />
                </td>
                <td>
                  <Link
                    to="/grants/$grantId"
                    params={{ grantId: grant.id }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {grant.name}
                  </Link>
                </td>
                <td>{grant.subject}</td>
                <td>
                  <div className="entries">
                    {grant.capabilities.map((capability, index) => (
                      <code key={`${capability.target.type}-${capabilityTarget(resources, capability).value}-${index}`}>
                        {capabilityLabel(resources, capability)}
                      </code>
                    ))}
                  </div>
                </td>
                <td>
                  <code>{grant.expiresAt ?? 'never'}</code>
                </td>
                <td className={status === 'active' ? 'allowed' : 'denied'}>
                  <code>{status}</code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {listing.length ? null : <p className="empty">{empty}</p>}
    </Pane>
  );
}

/**
 * The delegation chain above a grant, root first, one row per capability entry. Reading down the
 * table is reading the downscoping, which is the only way to see whether authority survives it.
 */
export function LineagePane({ lineage, resources }: { lineage: Grant[]; resources: State['resources'] }) {
  const addressed = lineage[lineage.length - 1];

  return (
    <Pane label="Lineage" meta={`${lineage.length} deep, root first`}>
      <table>
        <thead>
          <tr>
            <th>Grant</th>
            <th>Subject</th>
            <th>Target type</th>
            <th>Target</th>
            <th>Permissions</th>
            <th>Descendants</th>
            <th>Expires</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {lineage.flatMap((grant) => {
            const span = Math.max(grant.capabilities.length, 1);
            const status = grantStatus(grant);
            const facts = (
              <>
                <td rowSpan={span}>
                  {grant.id === addressed?.id ? (
                    grant.name
                  ) : (
                    <Link to="/grants/$grantId" params={{ grantId: grant.id }}>
                      {grant.name}
                    </Link>
                  )}
                </td>
                <td rowSpan={span}>{grant.subject}</td>
              </>
            );
            const trailing = (
              <>
                <td rowSpan={span}>
                  <code>{grant.expiresAt ?? 'never'}</code>
                </td>
                <td rowSpan={span} className={status === 'active' ? 'allowed' : 'denied'}>
                  <code>{status}</code>
                </td>
              </>
            );

            if (!grant.capabilities.length) {
              return [
                <tr key={grant.id}>
                  {facts}
                  <td colSpan={4} className="dim">
                    no capability entries
                  </td>
                  {trailing}
                </tr>,
              ];
            }

            return grant.capabilities.map((capability, index) => (
              <tr key={`${grant.id}-${capability.target.type}-${capabilityTarget(resources, capability).value}-${index}`}>
                {index === 0 ? facts : null}
                <td>
                  <code>{capability.target.type === 'resource' ? 'resource ID' : 'path'}</code>
                </td>
                <td>
                  <CapabilityResource resources={resources} capability={capability} />
                </td>
                <td>
                  <code>{capability.permissions.join(' ')}</code>
                </td>
                <td>
                  <code>{capability.descendants ? 'include' : 'root only'}</code>
                </td>
                {index === 0 ? trailing : null}
              </tr>
            ));
          })}
        </tbody>
      </table>
    </Pane>
  );
}

/** The tokens issued against the addressed grant, selected and operated on the same way grants are. */
export function TokenListing({
  tokens,
  selection,
  open,
  onOpen,
}: {
  tokens: Token[];
  selection: Selection<Token>;
  open: GrantOperation | null;
  onOpen: (operation: GrantOperation) => void;
}) {
  const targets = selection.targets;
  const status = (token: Token) => (token.revokedAt ? 'revoked' : isActive(token) ? 'active' : 'expired');

  return (
    <Pane
      head={
        <>
          <span className="pane-label">Tokens</span>
          <Actions>
            <Action label="Issue token" open={open === 'Issue token'} onClick={() => onOpen('Issue token')} />
            <Action
              label="Revoke token"
              count={targets.length}
              open={open === 'Revoke token'}
              disabled={!targets.length}
              onClick={() => onOpen('Revoke token')}
            />
          </Actions>
        </>
      }
      meta={`${tokens.length} issued`}
    >
      <table>
        <thead>
          <tr>
            <th className="check-cell">
              <Check
                label="Select every token"
                disabled={!tokens.length}
                checked={selection.allChecked}
                onChange={selection.toggleAll}
              />
            </th>
            <th>Label</th>
            <th>Status</th>
            <th>Hash</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr
              key={token.id}
              className={selection.isChecked(token.id) ? 'selected' : undefined}
              onClick={() => selection.toggle(token.id)}
            >
              <td className="check-cell">
                <Check
                  label={`Select ${token.label}`}
                  checked={selection.isChecked(token.id)}
                  onChange={() => selection.toggle(token.id)}
                />
              </td>
              <td>{token.label}</td>
              <td className={isActive(token) ? 'allowed' : 'denied'}>
                <code>{status(token)}</code>
              </td>
              <td>
                <code className="dim">{token.hash.slice(0, 16)}…</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tokens.length ? null : <p className="empty">No tokens reference this grant.</p>}
    </Pane>
  );
}
