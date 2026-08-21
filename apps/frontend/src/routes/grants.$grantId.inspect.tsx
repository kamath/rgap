import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import type { Grant } from '@rgap/core';
import { useRgapSnapshot } from '@rgap/react';
import { CapabilitiesPane } from '../capability-editor';
import { GrantBreadcrumb, LineagePane, TokenListing } from '../grant-listing';
import { IssueTokenDrawer, RevokeTokensDrawer, type GrantOperation } from '../grant-ops';
import { ObjectLine, PageTitle, useSelection } from '../panes';
import { grantLineage, lineageStatus } from '../tree';

export const Route = createFileRoute('/grants/$grantId/inspect')({ component: InspectGrant });

function InspectGrant() {
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

  return <GrantInspection grant={grant} />;
}

function GrantInspection({ grant }: { grant: Grant }) {
  const snapshot = useRgapSnapshot();
  const lineage = grantLineage(snapshot.grants, grant.id);
  const tokens = Object.values(snapshot.tokens).filter((record) => record.grantId === grant.id);
  const credentials = useSelection(`tokens:${grant.id}`, tokens);
  const [operation, setOperation] = useState<GrantOperation | null>(null);
  // Issuing acts on the addressed grant; revoking has nothing to act on without a selection.
  const drawer = operation === 'Issue token' || credentials.targets.length ? operation : null;
  const close = () => setOperation(null);

  return (
    <>
      <PageTitle title="Grants" note="One grant in full: where its authority comes from, and what exercises it." />
      <GrantBreadcrumb lineage={lineage} trailing="inspect" />
      <ObjectLine
        id={grant.id}
        fields={[
          ['subject', grant.subject],
          ['expires', grant.expiresAt ?? 'never'],
          ['status', lineageStatus(snapshot.grants, grant.id)],
          ['capabilities', grant.capabilities.length],
        ]}
      />
      <div className={drawer ? 'view open' : 'view'}>
        <div className="stack">
          <LineagePane lineage={lineage} resources={snapshot.resources} />
          <CapabilitiesPane grant={grant} />
          <TokenListing tokens={tokens} selection={credentials} open={drawer} onOpen={setOperation} />
        </div>
        {drawer === 'Issue token' ? <IssueTokenDrawer grant={grant} onClose={close} /> : null}
        {drawer === 'Revoke token' ? <RevokeTokensDrawer targets={credentials.targets} onClose={close} /> : null}
      </div>
    </>
  );
}
