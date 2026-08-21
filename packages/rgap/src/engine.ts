import type {
  AuthorizationDecision,
  AuthorizationRequest,
  CreateGrantInput,
  CreateResourceInput,
  DelegateGrantInput,
  Grant,
  IssuedToken,
  IssueTokenInput,
  MoveResourceInput,
  Resource,
  RevokeGrantInput,
  RevokeGrantOutput,
  RevokeTokenInput,
  RevokeTokenOutput,
  RgapErrorCode,
  JsonObject,
} from './schemas.js'

export interface RgapEngine {
  createResource(input: CreateResourceInput): Promise<Resource>
  moveResource(input: MoveResourceInput): Promise<Resource>

  createGrant(input: CreateGrantInput): Promise<Grant>
  delegate(input: DelegateGrantInput): Promise<Grant>

  issueToken(input: IssueTokenInput): Promise<IssuedToken>
  authorize(input: AuthorizationRequest): Promise<AuthorizationDecision>

  revokeToken(input: RevokeTokenInput): Promise<RevokeTokenOutput>
  revokeGrant(input: RevokeGrantInput): Promise<RevokeGrantOutput>
}

export class RgapError extends Error {
  readonly code: RgapErrorCode
  readonly details: JsonObject

  constructor(code: RgapErrorCode, message: string, details: JsonObject = {}) {
    super(message)
    this.name = 'RgapError'
    this.code = code
    this.details = details
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    }
  }
}
