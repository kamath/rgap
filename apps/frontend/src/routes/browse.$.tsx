import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import type { Resource, State } from '@rgap/core';
import { useRgapAuthority, useRgapClient, useRgapSnapshot } from '@rgap/react';
import { Execute, Json, Pane, PageTitle, ResponsePane, Tabs, useOperation, type ExecuteFn } from '../panes';
import { usePlane, useShell } from '../shell';
import { requireResourceId } from '@rgap/core';
import { canonical, childrenOf, parentPath, pathOf, planPath, resolvePath, segments, visibleIds } from '../tree';

export const Route = createFileRoute('/browse/$')({ component: Browse });

const operations = ['Create resource', 'Move', 'Delete'] as const;
type Operation = (typeof operations)[number];

function Browse() {
  const { _splat } = Route.useParams();
  const path = canonical(_splat ?? '');
  const snapshot = useRgapSnapshot();
  const { token } = useShell();
  const { authority } = useRgapAuthority(token);
  const visible = visibleIds(snapshot.resources, authority);
  const currentId = resolvePath(snapshot.resources, path);
  const current = currentId ? snapshot.resources[currentId] : null;
  const [selection, setSelection] = useState<{ path: string; id: string } | null>(null);
  const selectedId = selection?.path === path ? selection.id : null;
  const target = (selectedId && snapshot.resources[selectedId]) || current;
  const listing = childrenOf(snapshot.resources, currentId).filter((child) => !visible || visible.has(child.id));
  const granted = (id: string) => authority?.permissions[id]?.join(' ') ?? '';
  const missing = Boolean(path) && !current;
  // The operation state lives above the per-path form so a response survives the navigation it causes.
  const { response, execute } = useOperation();

  return (
    <>
      <PageTitle title="Browse resources" note="A resource tree addressed by path and read through the active token." />
      <Breadcrumb path={path} />
      <div className="pane-row">
        <Pane label="Contents" meta={visible ? 'narrowed by token' : `${listing.length} resources`}>
          {missing ? (
            <p className="empty">
              No resource exists at <code>{path}</code>.
            </p>
          ) : (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Id</th>
                    <th>Move</th>
                    <th>Delete</th>
                    <th>Perm</th>
                  </tr>
                </thead>
                <tbody>
                  {path ? (
                    <tr className="up">
                      <td colSpan={5}>
                        <Link to="/browse/$" params={{ _splat: parentPath(path) }}>
                          ..
                        </Link>
                      </td>
                    </tr>
                  ) : null}
                  {listing.map((child) => (
                    <tr
                      key={child.id}
                      className={child.id === selectedId ? 'selected' : undefined}
                      onClick={() => setSelection(child.id === selectedId ? null : { path, id: child.id })}
                    >
                      <td>
                        <Link to="/browse/$" params={{ _splat: pathOf(snapshot.resources, child.id) }}>
                          {child.name}
                        </Link>
                      </td>
                      <td>
                        <code>{child.id}</code>
                      </td>
                      <td>
                        <code>{child.movePolicy}</code>
                      </td>
                      <td>
                        <code>{child.deletePolicy}</code>
                      </td>
                      <td>
                        <code>{authority ? granted(child.id) || 'none' : '—'}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {listing.length ? null : <p className="empty">This resource has no children.</p>}
            </>
          )}
        </Pane>
        <Pane label="Object" meta={current?.id ?? 'root'}>
          <dl>
            <dt>path</dt>
            <dd>
              <code>{path || '/'}</code>
            </dd>
            <dt>id</dt>
            <dd>
              <code>{current?.id ?? '—'}</code>
            </dd>
            <dt>move</dt>
            <dd>
              <code>{current?.movePolicy ?? '—'}</code>
            </dd>
            <dt>delete</dt>
            <dd>
              <code>{current?.deletePolicy ?? '—'}</code>
            </dd>
            <dt>permissions</dt>
            <dd>
              <code>{current ? (authority ? granted(current.id) || 'none' : 'administrative') : '—'}</code>
            </dd>
            <dt>children</dt>
            <dd>
              <code>{missing ? '—' : listing.length}</code>
            </dd>
          </dl>
        </Pane>
      </div>
      <div className="pane-row">
        <Operations key={path} path={path} target={target} resources={snapshot.resources} execute={execute} />
        <ResponsePane response={response} />
      </div>
    </>
  );
}

function Operations({
  path,
  target,
  resources,
  execute,
}: {
  path: string;
  target: Resource | null;
  resources: State['resources'];
  execute: ExecuteFn;
}) {
  const client = useRgapClient();
  const navigate = useNavigate();
  const plane = usePlane();
  const [operation, setOperation] = useState<Operation>('Create resource');
  const [name, setName] = useState('');
  const [parent, setParent] = useState(path);
  const [destination, setDestination] = useState(path);
  const [movePolicy, setMovePolicy] = useState<Resource['movePolicy']>('normal');
  const [deletePolicy, setDeletePolicy] = useState<Resource['deletePolicy']>('revoke');
  const targetPath = target ? pathOf(resources, target.id) : null;
  // Commands name resources by stable ID, so every typed path is resolved before the request is built.
  const plan = planPath(resources, parent);
  const destinationId = resolvePath(resources, destination);

  // A parent that does not exist yet has no ID to show, so the preview omits it rather than claiming a root.
  const destinationMissing = Boolean(canonical(destination)) && !destinationId;
  const request =
    operation === 'Create resource'
      ? {
          method: 'createResource',
          params: { name, parentId: plan.missing.length ? undefined : plan.parentId, movePolicy, deletePolicy },
        }
      : operation === 'Move'
        ? { method: 'moveResource', params: { id: target?.id ?? null, parentId: destinationMissing ? undefined : destinationId } }
        : { method: 'deleteResource', params: { id: target?.id ?? null } };

  const submit = async () => {
    if (operation === 'Create resource') {
      await execute('createResource', async () => {
        let parentId = plan.parentId;
        for (const segment of plan.missing) {
          const created = await client.createResource({
            name: segment, parentId, movePolicy: 'normal', deletePolicy: 'revoke',
          });
          parentId = created.id;
        }
        const created = await client.createResource({ name, parentId, movePolicy, deletePolicy });
        setName('');
        return created;
      });
      return;
    }
    if (!target) return;
    if (operation === 'Move') {
      await execute('moveResource', () =>
        client.moveResource(target.id, canonical(destination) ? requireResourceId(resources, destination) : null),
      );
      return;
    }
    const deleted = target.id;
    if (await execute('deleteResource', () => client.deleteResource(deleted))) {
      if (deleted === resolvePath(resources, path)) {
        navigate({ to: '/browse/$', params: { _splat: parentPath(path) } });
      }
    }
  };

  return (
    <Pane
      head={<Tabs options={operations} value={operation} onChange={setOperation} />}
      meta={`${plane} plane · ${request.method}`}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {operation === 'Create resource' ? (
          <>
            <label>
              <span>name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="read_file" />
            </label>
            <label>
              <span>parent path</span>
              <input value={parent} onChange={(event) => setParent(event.target.value)} placeholder="empty for a root" />
            </label>
            <p className="field-note">
              {plan.missing.length
                ? `${plan.missing.join('/')} does not exist yet; the interface creates ${plan.missing.length === 1 ? 'it' : 'them'} first, one command per segment.`
                : 'A parent path that does not exist is created segment by segment before the resource.'}
            </p>
            <div className="field-row">
              <label>
                <span>move policy</span>
                <select value={movePolicy} onChange={(event) => setMovePolicy(event.target.value as Resource['movePolicy'])}>
                  <option value="normal">normal</option>
                  <option value="deny_while_granted">deny_while_granted</option>
                </select>
              </label>
              <label>
                <span>delete policy</span>
                <select
                  value={deletePolicy}
                  onChange={(event) => setDeletePolicy(event.target.value as Resource['deletePolicy'])}
                >
                  <option value="revoke">revoke</option>
                  <option value="deny_while_granted">deny_while_granted</option>
                </select>
              </label>
            </div>
          </>
        ) : (
          <>
            <label>
              <span>target</span>
              <input value={targetPath ?? 'select a resource'} readOnly />
            </label>
            <p className="field-note">
              {target ? 'Select a listing row to retarget this operation.' : 'Navigate to a resource or select a row.'}
            </p>
            {operation === 'Move' ? (
              <>
                <label>
                  <span>new parent path</span>
                  <input
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                    placeholder="empty for a root"
                  />
                </label>
                {destinationMissing ? (
                  <p className="field-note denied">No resource exists at {canonical(destination)}.</p>
                ) : (
                  <p className="field-note">An empty path moves this resource to a root.</p>
                )}
              </>
            ) : (
              <p className="field-note">Deletion removes this resource and its descendants.</p>
            )}
          </>
        )}
        <Json value={request} />
        <Execute label="Execute operation" />
      </form>
    </Pane>
  );
}

function Breadcrumb({ path }: { path: string }) {
  const parts = segments(path);
  return (
    <p className="breadcrumb">
      <Link to="/browse/$" params={{ _splat: '' }}>
        root
      </Link>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>
          <span className="dim"> / </span>
          <Link to="/browse/$" params={{ _splat: parts.slice(0, index + 1).join('/') }}>
            {part}
          </Link>
        </span>
      ))}
    </p>
  );
}
