import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { liveResources, type Capability, type Grant, type Permission, type RelocationPolicy } from '@rgap/core';
import { useRgapClient, useRgapSnapshot } from '@rgap/react';
import { boundsAt, uncovered, withPermission } from './capability-bounds';
import { CapabilityResource } from './grant-listing';
import { Action, Actions, Check, Execute, Form, Json, Pane, ResponseBlock, useOperation } from './panes';
import { usePlane } from './shell';
import { childrenOf, pathOf } from './tree';

/**
 * The addressed grant's entries. Reading them and setting them are the same pane: a drawer exists so
 * a form can sit beside content that stays useful, and here that content is the table being edited.
 */
export function CapabilitiesPane({ grant }: { grant: Grant }) {
  const [editing, setEditing] = useState(false);

  return editing ? (
    <CapabilityEditor grant={grant} onClose={() => setEditing(false)} />
  ) : (
    <Pane
      head={
        <>
          <span className="pane-label">Capabilities</span>
          <Actions>
            <Action label="Set capabilities" onClick={() => setEditing(true)} />
          </Actions>
        </>
      }
      meta={`${grant.capabilities.length} entries`}
    >
      <CapabilityTable grant={grant} />
    </Pane>
  );
}

function CapabilityTable({ grant }: { grant: Grant }) {
  const snapshot = useRgapSnapshot();

  if (!grant.capabilities.length) {
    return <p className="empty">This grant holds no capability entries, so it authorizes nothing.</p>;
  }

  return (
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
              <CapabilityResource resources={snapshot.resources} capability={capability} />
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
  );
}

function CapabilityEditor({ grant, onClose }: { grant: Grant; onClose: () => void }) {
  const client = useRgapClient();
  const snapshot = useRgapSnapshot();
  const plane = usePlane();
  const { response, execute } = useOperation();
  const parent = grant.parentId ? snapshot.grants[grant.parentId] ?? null : null;
  const [draft, setDraft] = useState<Capability[]>(() => structuredClone(grant.capabilities));
  const request = { method: 'setCapabilities', params: { grantId: grant.id, capabilities: draft } };

  const submit = async () => {
    const committed = await execute('setCapabilities', () => client.setCapabilities(grant.id, draft));
    if (committed) onClose();
  };

  const toggle = (resourceId: string) =>
    setDraft((held) => {
      if (held.some((entry) => entry.resourceId === resourceId)) {
        return held.filter((entry) => entry.resourceId !== resourceId);
      }
      const bounds = boundsAt(parent, snapshot.resources, resourceId);
      const hasChildren = childrenOf(snapshot.resources, resourceId).length > 0;
      return [
        ...held,
        {
          resourceId,
          permissions: [],
          // Pointing at a path means everything under it, where the parent allows that.
          descendants: hasChildren && bounds.descendants,
          relocation: bounds.relocations.includes('revoke_on_scope_exit')
            ? 'revoke_on_scope_exit'
            : bounds.relocations[bounds.relocations.length - 1] ?? 'deny_move',
        },
      ];
    });

  const amend = (resourceId: string, change: Partial<Capability>) =>
    setDraft((held) => held.map((entry) => (entry.resourceId === resourceId ? { ...entry, ...change } : entry)));

  return (
    <Pane
      head={
        <>
          <span className="pane-label">Capabilities</span>
          <Actions>
            <Action label="Set capabilities" open onClick={onClose} />
          </Actions>
        </>
      }
      meta={`${plane} plane · ${draft.length} entries`}
    >
      <Form onSubmit={submit}>
        <ResourcePicker
          selected={draft.map((entry) => entry.resourceId)}
          parent={parent}
          onToggle={toggle}
        />
        <DraftEntries draft={draft} parent={parent} onAmend={amend} onRemove={toggle} />
        <Json value={request} />
        <Execute label="Execute operation" />
        <ResponseBlock response={response} />
      </Form>
    </Pane>
  );
}

/** The resource tree, browsed the way the explorer browses it, with a checkbox per row. */
function ResourcePicker({
  selected,
  parent,
  onToggle,
}: {
  selected: string[];
  parent: Grant | null;
  onToggle: (resourceId: string) => void;
}) {
  const snapshot = useRgapSnapshot();
  const [location, setLocation] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const term = filter.trim().toLowerCase();

  // A filter searches whole paths across the tree, so a deep resource needs no walking to.
  const rows = term
    ? liveResources(snapshot.resources)
        .map((resource) => ({ resource, path: pathOf(snapshot.resources, resource.id) }))
        .filter((row) => row.path.toLowerCase().includes(term))
        .sort((left, right) => left.path.localeCompare(right.path))
    : childrenOf(snapshot.resources, location).map((resource) => ({
        resource,
        path: pathOf(snapshot.resources, resource.id),
      }));

  const trail: string[] = [];
  for (let id = location; id; id = snapshot.resources[id]?.parentId ?? null) trail.unshift(id);

  return (
    <div className="picker">
      <p className="breadcrumb">
        <button type="button" className="crumb" onClick={() => setLocation(null)}>
          root
        </button>
        {trail.map((id) => (
          <span key={id}>
            <span className="dim"> / </span>
            <button type="button" className="crumb" onClick={() => setLocation(id)}>
              {snapshot.resources[id].name}
            </button>
          </span>
        ))}
      </p>
      <label>
        <span>filter</span>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="search every path" />
      </label>
      <table>
        <thead>
          <tr>
            <th className="check-cell" />
            <th>{term ? 'Path' : 'Resource'}</th>
            <th>Children</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ resource, path }) => {
            const bounds = boundsAt(parent, snapshot.resources, resource.id);
            const children = childrenOf(snapshot.resources, resource.id).length;

            return (
              <tr key={resource.id}>
                <td className="check-cell">
                  <Check
                    label={`Select ${path}`}
                    checked={selected.includes(resource.id)}
                    disabled={!bounds.selectable}
                    onChange={() => onToggle(resource.id)}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="crumb"
                    onClick={() => {
                      setFilter('');
                      setLocation(resource.id);
                    }}
                  >
                    {term ? path : resource.name}
                  </button>
                </td>
                <td>
                  <code className="dim">{children}</code>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length ? null : (
        <p className="empty">{term ? 'No path matches.' : 'This resource has no children.'}</p>
      )}
      {parent ? (
        <p className="field-note">
          Only resources reached by <Link to="/grants/$grantId/inspect" params={{ grantId: parent.id }}>{parent.name}</Link> can be selected.
        </p>
      ) : null}
    </div>
  );
}

/** One row per selected entry, each carrying the controls that entry alone decides. */
function DraftEntries({
  draft,
  parent,
  onAmend,
  onRemove,
}: {
  draft: Capability[];
  parent: Grant | null;
  onAmend: (resourceId: string, change: Partial<Capability>) => void;
  onRemove: (resourceId: string) => void;
}) {
  const snapshot = useRgapSnapshot();

  if (!draft.length) {
    return <p className="empty">No entries selected. The grant will reach nothing.</p>;
  }

  return (
    <div className="entry-list">
      {draft.map((entry) => {
        const bounds = boundsAt(parent, snapshot.resources, entry.resourceId);
        const problem = uncovered(parent, snapshot.resources, entry);

        return (
          <div key={entry.resourceId} className={problem ? 'entry denied' : 'entry'}>
            <div className="entry-head">
              <code>{pathOf(snapshot.resources, entry.resourceId) || 'root'}</code>
              {problem ? <code className="denied">{problem}</code> : null}
              <button type="button" className="ghost" onClick={() => onRemove(entry.resourceId)}>
                remove
              </button>
            </div>
            <div className="checks">
              {bounds.permissions.map((permission: Permission) => (
                <label key={permission} className="check">
                  <input
                    type="checkbox"
                    checked={entry.permissions.includes(permission)}
                    onChange={(event) =>
                      onAmend(entry.resourceId, {
                        permissions: withPermission(entry.permissions, permission, event.target.checked),
                      })
                    }
                  />
                  {permission}
                </label>
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={entry.descendants}
                  disabled={!bounds.descendants}
                  onChange={(event) => onAmend(entry.resourceId, { descendants: event.target.checked })}
                />
                descendants
              </label>
              <select
                value={entry.relocation}
                onChange={(event) =>
                  onAmend(entry.resourceId, { relocation: event.target.value as RelocationPolicy })
                }
              >
                {bounds.relocations.map((policy) => (
                  <option key={policy} value={policy}>
                    {policy}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );
      })}
    </div>
  );
}
