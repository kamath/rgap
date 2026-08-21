import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { Grant, Token } from '@rgap/core';
import type { GrantOperation } from './grant-ops';
import { Action, Actions, Check, Pane, type useSelection } from './panes';
import { grantStatus, isActive } from './tree';

type Selection<T extends { id: string }> = ReturnType<typeof useSelection<T>>;

/** The delegation lineage, walked the way the resource breadcrumb walks a path. */
export function GrantBreadcrumb({ lineage }: { lineage: Grant[] }) {
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
    </p>
  );
}

/** The grants delegated from the addressed grant, or the root grants at the grant list. */
export function GrantListing({
  label,
  meta,
  createLabel,
  listing,
  selection,
  open,
  onOpen,
  up,
  empty,
}: {
  label: string;
  meta: string;
  createLabel: 'Create' | 'Delegate';
  listing: Grant[];
  selection: Selection<Grant>;
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
            <Action label={createLabel} open={open === 'Delegate'} onClick={() => onOpen('Delegate')} />
            <Action
              label="Revoke"
              count={targets.length}
              open={open === 'Revoke'}
              disabled={!targets.length}
              onClick={() => onOpen('Revoke')}
            />
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
          {listing.map((grant) => (
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
                <code>{grant.capabilities.length}</code>
              </td>
              <td>
                <code>{grant.expiresAt ?? 'never'}</code>
              </td>
              <td className={grantStatus(grant) === 'active' ? 'allowed' : 'denied'}>
                <code>{grantStatus(grant)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {listing.length ? null : <p className="empty">{empty}</p>}
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
