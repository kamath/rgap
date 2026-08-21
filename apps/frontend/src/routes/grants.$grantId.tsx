import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { isLive, type Grant } from '@rgap/core';
import { useRgapAuthority, useRgapSnapshot } from '@rgap/react';
import { GrantBreadcrumb, GrantListing, TokenListing } from '../grant-listing';
import {
  DelegateDrawer,
  IssueTokenDrawer,
  RevokeGrantsDrawer,
  RevokeTokensDrawer,
  type GrantOperation,
} from '../grant-ops';
import { ObjectLine, Pane, PageTitle, useSelection } from '../panes';
import { useShell } from '../shell';
import { childGrants, grantLineage, grantStatus, pathOf, visibleGrantIds } from '../tree';

export const Route = createFileRoute('/grants/$grantId')({ component: GrantDetail });

function GrantDetail() {
  const { grantId } = Route.useParams();
  const snapshot = useRgapSnapshot();
  const grant = snapshot.grants[grantId];

  if (!grant) {
    return (
      <p className="empty">
        Grant <code>{grantId}</code> does not exist. <Link to="/grants">Back to the grant list.</Link>
      </p>
    );
  }

  return <GrantView grant={grant} />;
}

function GrantView({ grant }: { grant: Grant }) {
  const snapshot = useRgapSnapshot();
  const { token } = useShell();
  const { authority } = useRgapAuthority(token);
  const visible = visibleGrantIds(snapshot.grants, authority);
  const lineage = grantLineage(snapshot.grants, grant.id);
  const listing = childGrants(snapshot.grants, grant.id).filter((child) => !visible || visible.has(child.id));
  const tokens = Object.values(snapshot.tokens).filter((record) => record.grantId === grant.id);

  const grants = useSelection(`grants:${grant.id}`, listing);
  const credentials = useSelection(`tokens:${grant.id}`, tokens);
  const [operation, setOperation] = useState<GrantOperation | null>(null);
  // Delegating and issuing act on the addressed grant; revoking acts on whichever listing holds the selection.
  const available: Record<GrantOperation, boolean> = {
    Delegate: true,
    'Issue token': true,
    Revoke: grants.targets.length > 0,
    'Revoke token': credentials.targets.length > 0,
  };
  const drawer = operation && available[operation] ? operation : null;
  const close = () => setOperation(null);

  return (
    <>
      <PageTitle title="Grants" note="Authority walked from the grant it was delegated from." />
      <GrantBreadcrumb lineage={lineage} />
      <ObjectLine
        id={grant.id}
        fields={[
          ['subject', grant.subject],
          ['expires', grant.expiresAt ?? 'never'],
          ['status', grantStatus(grant)],
          ['delegated', listing.length],
        ]}
      />
      <div className={drawer ? 'view open' : 'view'}>
        <div className="stack">
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
          <GrantListing
            label="Delegated"
            meta={visible ? 'narrowed to the token lineage' : `${listing.length} grants`}
            createLabel="Delegate"
            listing={listing}
            selection={grants}
            open={drawer}
            onOpen={setOperation}
            up={
              grant.parentId ? (
                <Link to="/grants/$grantId" params={{ grantId: grant.parentId }}>
                  ..
                </Link>
              ) : (
                <Link to="/grants">..</Link>
              )
            }
            empty="No grants are delegated from this grant."
          />
          <TokenListing tokens={tokens} selection={credentials} open={drawer} onOpen={setOperation} />
        </div>
        {drawer === 'Delegate' ? <DelegateDrawer parent={grant} onClose={close} /> : null}
        {drawer === 'Revoke' ? <RevokeGrantsDrawer targets={grants.targets} onClose={close} /> : null}
        {drawer === 'Issue token' ? <IssueTokenDrawer grant={grant} onClose={close} /> : null}
        {drawer === 'Revoke token' ? <RevokeTokensDrawer targets={credentials.targets} onClose={close} /> : null}
      </div>
    </>
  );
}
