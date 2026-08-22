import { useState } from 'react';
import type { Resource, ResourceId, State } from '@rgap/core';
import { useRgapClient } from '@rgap/react';
import { Drawer, Execute, Form, Json, ResponseBlock, Targets, plural, useOperation } from './panes';
import { usePlane } from './shell';
import { canonical, pathOf, resolvePath } from './tree';

export const resourceOperations = ['Create', 'Move', 'Delete'] as const;
export type ResourceOperation = (typeof resourceOperations)[number];

type DrawerProps = {
  path: string;
  parentId: ResourceId | null;
  targets: Resource[];
  resources: State['resources'];
  onClose: () => void;
};

export function ResourceDrawer({ operation, ...props }: DrawerProps & { operation: ResourceOperation }) {
  if (operation === 'Create') return <CreateDrawer {...props} />;
  if (operation === 'Move') return <MoveDrawer {...props} />;
  return <DeleteDrawer {...props} />;
}

function CreateDrawer({ path, parentId, onClose }: DrawerProps) {
  const client = useRgapClient();
  const plane = usePlane();
  const { response, execute } = useOperation();
  const [name, setName] = useState('');
  // The resource is created where the listing already is, so the parent is stated rather than typed.
  const request = { method: 'createResource', params: { name, parentId } };

  const submit = async () => {
    const committed = await execute('createResource', () => client.createResource({ name, parentId }));
    if (committed) onClose();
  };

  return (
    <Drawer label="Create resource" meta={`${plane} plane`} onClose={onClose}>
      <Form onSubmit={submit}>
        <label>
          <span>name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="read_file" />
        </label>
        <label>
          <span>parent</span>
          <input value={path || 'root'} readOnly />
        </label>
        <p className="field-note">
          {parentId
            ? 'The resource is created here. Navigate to another location to create one there.'
            : 'A resource created at the root is a root resource, which no token authorizes.'}
        </p>
        <Json value={request} />
        <Execute label="Execute operation" />
        <ResponseBlock response={response} />
      </Form>
    </Drawer>
  );
}

function MoveDrawer({ path, targets, resources, onClose }: DrawerProps) {
  const client = useRgapClient();
  const plane = usePlane();
  const { response, executeEach } = useOperation();
  const [destination, setDestination] = useState(path);
  const destinationId = resolvePath(resources, destination);
  // A parent that does not exist yet has no ID to show, so the preview omits it rather than claiming a root.
  const destinationMissing = Boolean(canonical(destination)) && !destinationId;
  const request = {
    method: 'moveResource',
    calls: targets.map((target) => ({ id: target.id, parentId: destinationMissing ? undefined : destinationId })),
  };

  const submit = async () => {
    if (destinationMissing) return;
    const committed = await executeEach(
      'moveResource',
      targets,
      (target) => pathOf(resources, target.id),
      (target) => client.moveResource(target.id, destinationId),
    );
    if (committed) onClose();
  };

  return (
    <Drawer label={`Move · ${plural(targets.length, 'resource')}`} meta={`${plane} plane`} onClose={onClose}>
      <Form onSubmit={submit}>
        <Targets items={targets.map((target) => pathOf(resources, target.id))} />
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
          <p className="field-note">
            An empty path moves {targets.length === 1 ? 'this resource' : 'these resources'} to{' '}
            {targets.length === 1 ? 'a root' : 'roots'}. Each move is its own command.
          </p>
        )}
        <Json value={request} />
        <Execute label="Execute operation" />
        <ResponseBlock response={response} />
      </Form>
    </Drawer>
  );
}

function DeleteDrawer({ targets, resources, onClose }: DrawerProps) {
  const client = useRgapClient();
  const plane = usePlane();
  const { response, executeEach } = useOperation();
  const request = { method: 'deleteResource', calls: targets.map((target) => ({ id: target.id })) };

  const submit = async () => {
    const committed = await executeEach(
      'deleteResource',
      targets,
      (target) => pathOf(resources, target.id),
      (target) => client.deleteResource(target.id),
    );
    if (committed) onClose();
  };

  return (
    <Drawer label={`Delete · ${plural(targets.length, 'resource')}`} meta={`${plane} plane`} onClose={onClose}>
      <Form onSubmit={submit}>
        <Targets items={targets.map((target) => pathOf(resources, target.id))} />
        <p className="field-note">
          Deletion removes {targets.length === 1 ? 'this resource' : 'each of these resources'} together with its
          descendants. Each deletion is its own command.
        </p>
        <Json value={request} />
        <Execute label="Execute operation" />
        <ResponseBlock response={response} />
      </Form>
    </Drawer>
  );
}
