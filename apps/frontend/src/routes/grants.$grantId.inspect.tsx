import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import type { Grant } from '@rgap/core';
import {
  useAllResources,
  useAllTokens,
  useGrant,
  useGrantLineage,
  useGrantRecords,
  useResourceRecords,
} from '@rgap/react';
import { CapabilitiesPane } from '../capability-editor';
import { GrantBreadcrumb, LineagePane, TokenListing } from '../grant-listing';
import { IssueTokenDrawer, RevokeTokensDrawer, type GrantOperation } from '../grant-ops';
import { ObjectLine, PageTitle, useSelection } from '../panes';
import { lineageStatus } from '../tree';

export const Route = createFileRoute('/grants/$grantId/inspect')({ component: InspectGrant });

function InspectGrant() {
  const { grantId } = Route.useParams();
  const grant = useGrant(grantId as Grant['id']);

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
  const grants = useGrantRecords();
  const resources = useResourceRecords();
  useAllResources();
  const lineage = useGrantLineage(grant.id);
  const tokens = useAllTokens({ grantId: grant.id });
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
          ['expires', grant.expiresAt ?? 'never'],
          ['status', lineageStatus(grants, grant.id)],
          ['capabilities', grant.capabilities.length],
        ]}
      />
      <div className={drawer ? 'view open' : 'view'}>
        <div className="stack">
          <LineagePane lineage={lineage} resources={resources} />
          <CapabilitiesPane grant={grant} />
          <TokenListing tokens={tokens} selection={credentials} open={drawer} onOpen={setOperation} />
        </div>
        {drawer === 'Issue token' ? <IssueTokenDrawer grant={grant} onClose={close} /> : null}
        {drawer === 'Revoke token' ? <RevokeTokensDrawer targets={credentials.targets} onClose={close} /> : null}
      </div>
    </>
  );
}
