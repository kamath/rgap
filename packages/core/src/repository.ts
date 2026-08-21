import type {
  AuthorityView,
  CreateGrantInput,
  CreateResourceAtPathInput,
  Decision,
  Grant,
  Permission,
  Resource,
  State,
  Token,
} from './domain';

export type IssuedToken = { record: Token; value: string };

export interface RgapRepository {
  readState(): Promise<State>;
  createResource(input: CreateResourceAtPathInput): Promise<Resource>;
  moveResource(id: string, parentPath: string): Promise<Resource>;
  deleteResource(id: string): Promise<void>;
  createGrant(input: CreateGrantInput): Promise<Grant>;
  issueToken(grantId: string, label: string): Promise<IssuedToken>;
  revokeToken(id: string): Promise<void>;
  revokeGrant(id: string): Promise<void>;
  authorize(token: string, resourceId: string, permission: Permission): Promise<Decision>;
  inspectToken(token: string): Promise<AuthorityView>;
  reset(): Promise<void>;
}
