import type {
  AuthorityView,
  Capability,
  CreateGrantInput,
  CreateResourceInput,
  Decision,
  Grant,
  GrantId,
  Permission,
  Resource,
  ResourceId,
  State,
  Token,
  TokenId,
  TokenValue,
} from './domain';

export type IssuedToken = { record: Token; value: TokenValue };

/**
 * Selects an authorized or explicitly administrative command plane over one backing store.
 * The store itself exposes no resource or grant commands.
 */
export interface RgapStore {
  as(token: TokenValue): RgapRepository;
  admin(): RgapRepository;
}

export interface RgapRepository {
  readState(): Promise<State>;
  createResource(input: CreateResourceInput): Promise<Resource>;
  moveResource(id: ResourceId, parentId: ResourceId | null): Promise<Resource>;
  deleteResource(id: ResourceId): Promise<void>;
  createGrant(input: CreateGrantInput): Promise<Grant>;
  setCapabilities(grantId: GrantId, capabilities: Capability[]): Promise<Grant>;
  issueToken(grantId: GrantId, label: string): Promise<IssuedToken>;
  revokeToken(id: TokenId): Promise<void>;
  revokeGrant(id: GrantId): Promise<void>;
  authorize(token: TokenValue, resourceId: ResourceId, permission: Permission): Promise<Decision>;
  inspectToken(token: TokenValue): Promise<AuthorityView>;
  reset(): Promise<void>;
}
