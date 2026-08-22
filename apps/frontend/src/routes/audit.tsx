import { createFileRoute } from '@tanstack/react-router';
import { useAudit } from '@rgap/react';
import { Pane, PageTitle } from '../panes';

export const Route = createFileRoute('/audit')({ component: Audit });

function Audit() {
  const { records: events } = useAudit({ limit: 100 });

  return (
    <>
      <PageTitle title="Audit log" note="Every command and decision recorded in the same commit as its state change." />
      <div className="pane-row single">
        <Pane label="Events" meta={`${events.length} recorded`}>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Target</th>
                <th>Result</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>
                    <code className="dim">{event.at}</code>
                  </td>
                  <td>
                    <code>{event.action}</code>
                  </td>
                  <td>
                    <code>{event.target}</code>
                  </td>
                  <td className={event.result === 'denied' ? 'denied' : event.result === 'allowed' ? 'allowed' : undefined}>
                    <code>{event.result}</code>
                  </td>
                  <td>{event.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length ? null : <p className="empty">No events recorded yet.</p>}
        </Pane>
      </div>
    </>
  );
}
