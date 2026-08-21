import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useRgapAuthority, useRgapSnapshot } from '@rgap/react';
import { Action, Actions, Check, ObjectLine, Pane, PageTitle, useSelection } from '../panes';
import { ResourceDrawer, type ResourceOperation } from '../resource-ops';
import { useShell } from '../shell';
import { canonical, childrenOf, parentPath, pathOf, resolvePath, segments, visibleIds } from '../tree';

export const Route = createFileRoute('/browse/$')({ component: Browse });

function Browse() {
  const { _splat } = Route.useParams();
  const path = canonical(_splat ?? '');
  const snapshot = useRgapSnapshot();
  const { token } = useShell();
  const { authority } = useRgapAuthority(token);
  const visible = visibleIds(snapshot.resources, authority);
  const currentId = resolvePath(snapshot.resources, path);
  const current = currentId ? snapshot.resources[currentId] : null;
  const missing = Boolean(path) && !current;
  const listing = childrenOf(snapshot.resources, currentId).filter((child) => !visible || visible.has(child.id));
  const granted = (id: string) => authority?.permissions[id]?.join(' ') ?? '';

  const selection = useSelection(path, listing);
  const targets = selection.targets;
  const [operation, setOperation] = useState<ResourceOperation | null>(null);
  // Move and delete have nothing to act on without a selection, so losing one closes their drawer.
  const drawer = operation === 'Create' || targets.length ? operation : null;

  return (
    <>
      <PageTitle title="Browse resources" note="A resource tree addressed by path and read through the active token." />
      <Breadcrumb path={path} />
      {missing ? null : (
        <ObjectLine
          id={current?.id ?? 'root'}
          fields={[
            ['permissions', current ? (authority ? granted(current.id) || 'none' : 'administrative') : '—'],
            ['children', listing.length],
          ]}
        />
      )}
      <div className={drawer ? 'view open' : 'view'}>
        <div className="stack">
          <Pane
            head={
              <>
                <span className="pane-label">Contents</span>
                <Actions>
                  <Action
                    label="Create"
                    open={drawer === 'Create'}
                    disabled={missing}
                    onClick={() => setOperation('Create')}
                  />
                  <Action
                    label="Move"
                    count={targets.length}
                    open={drawer === 'Move'}
                    disabled={!targets.length}
                    onClick={() => setOperation('Move')}
                  />
                  <Action
                    label="Delete"
                    count={targets.length}
                    open={drawer === 'Delete'}
                    disabled={!targets.length}
                    onClick={() => setOperation('Delete')}
                  />
                </Actions>
              </>
            }
            meta={visible ? 'narrowed by token' : `${listing.length} resources`}
          >
            {missing ? (
              <p className="empty">
                No resource exists at <code>{path}</code>.
              </p>
            ) : (
              <>
                <table>
                  <thead>
                    <tr>
                      <th className="check-cell">
                        <Check
                          label="Select every resource"
                          disabled={!listing.length}
                          checked={selection.allChecked}
                          onChange={selection.toggleAll}
                        />
                      </th>
                      <th>Name</th>
                      <th>Id</th>
                      <th>Perm</th>
                    </tr>
                  </thead>
                  <tbody>
                    {path ? (
                      <tr className="up">
                        <td />
                        <td colSpan={3}>
                          <Link to="/browse/$" params={{ _splat: parentPath(path) }}>
                            ..
                          </Link>
                        </td>
                      </tr>
                    ) : null}
                    {listing.map((child) => (
                      <tr
                        key={child.id}
                        className={selection.isChecked(child.id) ? 'selected' : undefined}
                        onClick={() => selection.toggle(child.id)}
                      >
                        <td className="check-cell">
                          <Check
                            label={`Select ${child.name}`}
                            checked={selection.isChecked(child.id)}
                            onChange={() => selection.toggle(child.id)}
                          />
                        </td>
                        <td>
                          <Link
                            to="/browse/$"
                            params={{ _splat: pathOf(snapshot.resources, child.id) }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {child.name}
                          </Link>
                        </td>
                        <td>
                          <code>{child.id}</code>
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
        </div>
        {drawer ? (
          <ResourceDrawer
            key={`${drawer}-${path}`}
            operation={drawer}
            path={path}
            parentId={currentId}
            targets={targets}
            resources={snapshot.resources}
            onClose={() => setOperation(null)}
          />
        ) : null}
      </div>
    </>
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
