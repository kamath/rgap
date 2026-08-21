import { Link, createFileRoute } from '@tanstack/react-router';
import { useRgapAuthority, useRgapSnapshot } from '@rgap/react';
import { GrantFields } from '../grant-form';
import { Pane, PageTitle, ResponsePane, useOperation } from '../panes';
import { usePlane, useShell } from '../shell';
import { grantRows, grantStatus, isDelegatedFrom } from '../tree';

export const Route = createFileRoute('/grants/')({ component: Grants });

function Grants() {
  const snapshot = useRgapSnapshot();
  const { token } = useShell();
  const { authority } = useRgapAuthority(token);
  const { response, execute } = useOperation();
  const plane = usePlane();
  const focus = authority?.valid ? authority : null;
  const rows = grantRows(snapshot.grants).filter(
    ({ grant }) =>
      !focus ||
      focus.lineage.includes(grant.id) ||
      (focus.grantId ? isDelegatedFrom(snapshot.grants, grant.id, focus.grantId) : false),
  );

  return (
    <>
      <PageTitle title="Grant tree" note="Authority indented under the grant it was delegated from." />
      <div className="pane-row single">
        <Pane label="Grants" meta={focus ? 'narrowed to the token lineage' : `${rows.length} grants`}>
          <table>
            <thead>
              <tr>
                <th>Grant</th>
                <th>Subject</th>
                <th>Capabilities</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ grant, depth }) => (
                <tr key={grant.id}>
                  <td style={{ paddingLeft: `${depth * 1.4 + 0.7}rem` }}>
                    {depth ? <span className="dim">└ </span> : null}
                    <Link to="/grants/$grantId" params={{ grantId: grant.id }}>
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
          {rows.length ? null : <p className="empty">No grants are visible.</p>}
        </Pane>
      </div>
      <div className="pane-row">
        <Pane label="Create root grant" meta={`${plane} plane · createGrant`}>
          <GrantFields execute={execute} />
        </Pane>
        <ResponsePane response={response} />
      </div>
    </>
  );
}
