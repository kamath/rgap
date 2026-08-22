import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useAllGrants, useAllResources, useGrantRecords, useResourceRecords } from '@rgap/react';
import { GrantBreadcrumb, GrantListing } from '../grant-listing';
import { CreateGrantDrawer, RevokeGrantsDrawer, type GrantOperation } from '../grant-ops';
import { PageTitle, useSelection } from '../panes';
import { useShell } from '../shell';

export const Route = createFileRoute('/grants/')({ component: Grants });

function Grants() {
  const grants = useGrantRecords();
  const resources = useResourceRecords();
  const listing = useAllGrants({ parentId: null });
  useAllResources();
  const { token } = useShell();
  const visible = Boolean(token.trim());
  const selection = useSelection('grants', listing);
  const [operation, setOperation] = useState<GrantOperation | null>(null);
  // Creating a root grant needs no selection; revoking has nothing to act on without one.
  const drawer = operation === 'Create' || selection.targets.length ? operation : null;
  const close = () => setOperation(null);

  return (
    <>
      <PageTitle title="Grants" note="Authority walked from the grant it was delegated from." />
      <GrantBreadcrumb lineage={[]} />
      <div className={drawer ? 'view open' : 'view'}>
        <div className="stack">
          <GrantListing
            label="Root grants"
            meta={visible ? 'narrowed to the token lineage' : `${listing.length} grants`}
            listing={listing}
            grants={grants}
            resources={resources}
            selection={selection}
            inspect={null}
            open={drawer}
            onOpen={setOperation}
            empty="No root grants are visible."
          />
        </div>
        {drawer === 'Create' ? <CreateGrantDrawer parent={null} onClose={close} /> : null}
        {drawer === 'Revoke' ? <RevokeGrantsDrawer targets={selection.targets} onClose={close} /> : null}
      </div>
    </>
  );
}
