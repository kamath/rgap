import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  isPathCapability,
  liveResources,
  normalizePath,
  type Capability,
  type Grant,
  type Permission,
  type ResourceId,
} from '@rgap/core';
import {
  useAllResources,
  useGrant,
  useResourceRecords,
  useRgapClient,
} from '@rgap/react';
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
  const resources = useResourceRecords();
  useAllResources();

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
        </tr>
      </thead>
      <tbody>
        {grant.capabilities.map((capability, index) => {
          const target = capabilityTarget(resources, capability);
          return (
            <tr key={`${target.type}-${target.value}-${index}`}>
              <td>
                <code>{target.type === 'resource' ? 'resource ID' : 'path'}</code>
              </td>
              <td>
                <CapabilityResource resources={resources} capability={capability} />
              </td>
              <td>
                <code>{capability.permissions.join(' ')}</code>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CapabilityEditor({ grant, onClose }: { grant: Grant; onClose: () => void }) {
  const client = useRgapClient();
  const plane = usePlane();
  const { response, execute } = useOperation();
  const parent = useGrant(grant.parentId);
  const [draft, setDraft] = useState<Capability[]>(() => structuredClone(grant.capabilities));
  const [targetType, setTargetType] = useState<'resource' | 'path'>('resource');
  const [pathTarget, setPathTarget] = useState('');
  const normalizedDraft = draft.map((entry) =>
    isPathCapability(entry) ? { ...entry, path: normalizePath(entry.path) } : entry,
  );
  const request = { grant: grant.id, method: 'capabilities.set', params: { capabilities: normalizedDraft } };

  const submit = async () => {
    const committed = await execute('capabilities.set', async () =>
      (await client.grants.get(grant.id)).capabilities.set(normalizedDraft));
    if (committed) onClose();
  };

  const toggle = (id: ResourceId) =>
    setDraft((held) => {
      if (held.some((entry) => !isPathCapability(entry) && entry.resourceId === id)) {
        return held.filter((entry) => isPathCapability(entry) || entry.resourceId !== id);
      }
      return [...held, { resourceId: id, permissions: [] }];
    });

  const addPath = () => {
    const path = normalizePath(pathTarget);
    if (!path) return;
    setDraft((held) => [...held, { path, permissions: [] }]);
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
          <select value={targetType} onChange={(event) => setTargetType(event.target.value as 'resource' | 'path')}>
            <option value="resource">resource ID</option>
            <option value="path">path</option>
          </select>
        </label>
        {targetType === 'resource' ? (
          <ResourcePicker
            selected={draft.flatMap((entry) => isPathCapability(entry) ? [] : [entry.resourceId])}
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
  const resources = useResourceRecords();
  const [location, setLocation] = useState<ResourceId | null>(null);
  const [filter, setFilter] = useState('');
  const term = filter.trim().toLowerCase();
  const { records: children } = useAllResources({ parentId: location });
  useAllResources();

  // A filter searches whole paths across the tree, so a deep resource needs no walking to.
  const rows = term
    ? liveResources(resources)
        .map((resource) => ({ resource, path: pathOf(resources, resource.id) }))
        .filter((row) => row.path.toLowerCase().includes(term))
        .sort((left, right) => left.path.localeCompare(right.path))
    : children.map((resource) => ({
        resource,
        path: pathOf(resources, resource.id),
      }));

  const trail: ResourceId[] = [];
  for (let id = location; id; id = resources[id]?.parentId ?? null) trail.unshift(id);

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
              {resources[id].name}
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
            const bounds = boundsAt(parent, resources, { resourceId: resource.id });
            const childCount = childrenOf(resources, resource.id).length;

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
                  <code className="dim">{childCount}</code>
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
  const resources = useResourceRecords();

  if (!draft.length) {
    return <p className="empty">No entries selected. The grant will reach nothing.</p>;
  }

  return (
    <div className="entry-list">
      {draft.map((entry, index) => {
        const target = capabilityTarget(resources, entry);
        const bounds = boundsAt(
          parent,
          resources,
          isPathCapability(entry) ? { path: entry.path } : { resourceId: entry.resourceId },
        );
        const problem = uncovered(parent, resources, entry);

        return (
          <div key={index} className={problem ? 'entry denied' : 'entry'}>
            <div className="entry-head">
              <code>{isPathCapability(entry) ? 'path' : 'resource ID'}</code>
              {isPathCapability(entry) ? (
                <input
                  aria-label={`Path target ${index + 1}`}
                  value={entry.path}
                  onChange={(event) => onAmend(index, { path: event.target.value })}
                  onBlur={(event) => onAmend(index, { path: normalizePath(event.target.value) })}
                />
              ) : (
                <>
                  <code>{entry.resourceId}</code>
                  <code className="dim">{target.path}</code>
                </>
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
            </div>
          </div>
        );
      })}
    </div>
  );
}
