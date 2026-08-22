import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  liveResources,
  normalizePath,
  type Capability,
  type CapabilityTarget,
  type Grant,
  type Permission,
  type ResourceId,
} from '@rgap/core';
import { useRgapClient, useRgapSnapshot } from '@rgap/react';
import { boundsAt, uncovered, withPermission } from './capability-bounds';
import { CapabilityResource } from './grant-listing';
import { Action, Actions, Check, Execute, Form, Json, Pane, ResponseBlock, useOperation } from './panes';
import { usePlane } from './shell';
import { capabilityTarget, childrenOf, pathOf } from './tree';

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
          <th>Target type</th>
          <th>Target</th>
          <th>Permissions</th>
          <th>Descendants</th>
        </tr>
      </thead>
      <tbody>
        {grant.capabilities.map((capability, index) => (
          <tr key={`${capability.target.type}-${capabilityTarget(snapshot.resources, capability).value}-${index}`}>
            <td>
              <code>{capability.target.type === 'resource' ? 'resource ID' : 'path'}</code>
            </td>
            <td>
              <CapabilityResource resources={snapshot.resources} capability={capability} />
            </td>
            <td>
              <code>{capability.permissions.join(' ')}</code>
            </td>
            <td>
              <code>{capability.descendants ? 'include' : 'root only'}</code>
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
  const [targetType, setTargetType] = useState<CapabilityTarget['type']>('resource');
  const [pathTarget, setPathTarget] = useState('');
  const normalizedDraft = draft.map((entry) =>
    entry.target.type === 'path'
      ? { ...entry, target: { type: 'path' as const, path: normalizePath(entry.target.path) } }
      : entry,
  );
  const request = { grant: grant.id, method: 'capabilities.set', params: { capabilities: normalizedDraft } };

  const submit = async () => {
    const committed = await execute('capabilities.set', async () =>
      (await client.grants.get(grant.id)).capabilities.set(normalizedDraft));
    if (committed) onClose();
  };

  const toggle = (id: ResourceId) =>
    setDraft((held) => {
      if (held.some((entry) => entry.target.type === 'resource' && entry.target.resourceId === id)) {
        return held.filter((entry) => entry.target.type !== 'resource' || entry.target.resourceId !== id);
      }
      const target = { type: 'resource' as const, resourceId: id };
      const bounds = boundsAt(parent, snapshot.resources, target);
      const hasChildren = childrenOf(snapshot.resources, id).length > 0;
      return [
        ...held,
        {
          target,
          permissions: [],
          descendants: hasChildren && bounds.descendants,
        },
      ];
    });

  const addPath = () => {
    const path = normalizePath(pathTarget);
    if (!path) return;
    setDraft((held) => [
      ...held,
      { target: { type: 'path', path }, permissions: [], descendants: false },
    ]);
    setPathTarget('');
  };

  const amend = (index: number, change: Partial<Capability>) =>
    setDraft((held) => held.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...change } : entry)));
  const remove = (index: number) => setDraft((held) => held.filter((_, entryIndex) => entryIndex !== index));

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
        <label>
          <span>target type</span>
          <select value={targetType} onChange={(event) => setTargetType(event.target.value as CapabilityTarget['type'])}>
            <option value="resource">resource ID</option>
            <option value="path">path</option>
          </select>
        </label>
        {targetType === 'resource' ? (
          <ResourcePicker
            selected={draft.flatMap((entry) => entry.target.type === 'resource' ? [entry.target.resourceId] : [])}
            parent={parent}
            onToggle={toggle}
          />
        ) : (
          <div className="picker">
            <label>
              <span>normalized path</span>
              <input
                value={pathTarget}
                onChange={(event) => setPathTarget(event.target.value)}
                placeholder="projects/alpha/future"
              />
            </label>
            <p className="field-note">
              The location does not need to exist. Slashes and surrounding whitespace are normalized when added.
            </p>
            <button type="button" className="ghost" disabled={!normalizePath(pathTarget)} onClick={addPath}>
              add path target
            </button>
          </div>
        )}
        <DraftEntries draft={draft} parent={parent} onAmend={amend} onRemove={remove} />
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
  selected: ResourceId[];
  parent: Grant | null;
  onToggle: (id: ResourceId) => void;
}) {
  const snapshot = useRgapSnapshot();
  const [location, setLocation] = useState<ResourceId | null>(null);
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

  const trail: ResourceId[] = [];
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
            const bounds = boundsAt(parent, snapshot.resources, { type: 'resource', resourceId: resource.id });
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
  onAmend: (index: number, change: Partial<Capability>) => void;
  onRemove: (index: number) => void;
}) {
  const snapshot = useRgapSnapshot();

  if (!draft.length) {
    return <p className="empty">No entries selected. The grant will reach nothing.</p>;
  }

  return (
    <div className="entry-list">
      {draft.map((entry, index) => {
        const target = capabilityTarget(snapshot.resources, entry);
        const bounds = boundsAt(parent, snapshot.resources, entry.target);
        const problem = uncovered(parent, snapshot.resources, entry);

        return (
          <div key={index} className={problem ? 'entry denied' : 'entry'}>
            <div className="entry-head">
              <code>{entry.target.type === 'resource' ? 'resource ID' : 'path'}</code>
              {entry.target.type === 'resource' ? (
                <>
                  <code>{entry.target.resourceId}</code>
                  <code className="dim">{target.path}</code>
                </>
              ) : (
                <input
                  aria-label={`Path target ${index + 1}`}
                  value={entry.target.path}
                  onChange={(event) =>
                    onAmend(index, { target: { type: 'path', path: event.target.value } })
                  }
                  onBlur={(event) =>
                    onAmend(index, { target: { type: 'path', path: normalizePath(event.target.value) } })
                  }
                />
              )}
              {target.state === 'empty' ? <code className="denied">empty</code> : null}
              {target.state === 'deleted' ? <code className="denied">deleted</code> : null}
              {problem ? <code className="denied">{problem}</code> : null}
              <button type="button" className="ghost" onClick={() => onRemove(index)}>
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
                      onAmend(index, {
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
                  onChange={(event) => onAmend(index, { descendants: event.target.checked })}
                />
                descendants
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}
