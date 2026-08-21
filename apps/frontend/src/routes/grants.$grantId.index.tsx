import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import type { Grant } from '@rgap/core';
import { useRgapAuthority, useRgapSnapshot } from '@rgap/react';
import { GrantBreadcrumb, GrantListing } from '../grant-listing';
import { CreateGrantDrawer, RevokeGrantsDrawer, type GrantOperation } from '../grant-ops';
import { ObjectLine, PageTitle, useSelection } from '../panes';
import { useShell } from '../shell';
import { childGrants, grantLineage, lineageStatus, visibleGrantIds } from '../tree';

export const Route = createFileRoute('/grants/$grantId/')({ component: GrantDetail });

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
  const selection = useSelection(`grants:${grant.id}`, listing);
  const [operation, setOperation] = useState<GrantOperation | null>(null);
  // Delegating acts on the addressed grant; revoking has nothing to act on without a selection.
  const drawer = operation === 'Create' || selection.targets.length ? operation : null;
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
          ['status', lineageStatus(snapshot.grants, grant.id)],
          ['delegated', listing.length],
        ]}
      />
      <div className={drawer ? 'view open' : 'view'}>
        <div className="stack">
          <GrantListing
            label="Delegated"
            meta={visible ? 'narrowed to the token lineage' : `${listing.length} grants`}
            listing={listing}
            grants={snapshot.grants}
            resources={snapshot.resources}
            selection={selection}
            inspect={grant.id}
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
        </div>
        {drawer === 'Create' ? <CreateGrantDrawer parent={grant} onClose={close} /> : null}
        {drawer === 'Revoke' ? <RevokeGrantsDrawer targets={selection.targets} onClose={close} /> : null}
      </div>
    </>
  );
}
