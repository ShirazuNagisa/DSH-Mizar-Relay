/**
 * The account service's stored and wire shapes.
 *
 * Kept in one file so the API surface is reviewable at a glance. The public
 * `AccountUser` is what the phone decodes; the stored `UserRecord` is a superset
 * that never leaves the server. The difference between the two is the whole
 * privacy story: password hash, token hash, Apple `sub`, and transaction JWS are
 * stored and are not public.
 *
 * @module dsh-mizar-relay/accounts/types
 */

/** How an avatar was chosen. */
export type AvatarSpec =
  | {
      readonly kind: 'gravatar'
      readonly url: string
      /** Always present, so a blocked image still draws something. */
      readonly colors: readonly string[]
      readonly initials: string
    }
  | {
      readonly kind: 'generated'
      readonly colors: readonly string[]
      readonly initials: string
    }

/** One device seen for an account. */
export interface DeviceRecord {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly platform: string
  readonly appVersion: string
  loginAt: number
  lastSeenAt: number
  revokedAt: number | null
}

/** The App Store side of a user's entitlement. */
export interface AppStoreEntitlement {
  /** End of the paid period, epoch ms, or `null` after a revocation. */
  paidUntil: number | null
  readonly originalTransactionId: string
  productId: string
  readonly environment: string
  autoRenew: boolean
  revokedAt: number | null
  lastVerifiedAt: number
}

/** Everything that can make an account paid. */
export interface Entitlements {
  /** Invite code / admin grant, epoch ms. */
  grantedPaidUntil: number | null
  /** App Store subscription, or `null`. */
  appStore: AppStoreEntitlement | null
}

/** One stored account. */
export interface UserRecord {
  readonly id: string
  readonly username: string
  readonly usernameKey: string
  readonly email: string | null
  readonly emailKey: string | null
  emailVerified: boolean
  readonly passwordHash: string | null
  appleSub: string | null
  githubId: string | null
  githubLogin: string | null
  readonly avatar: AvatarSpec
  disabled: boolean
  readonly createdAt: number
  updatedAt: number
  lastSeenAt: number
  readonly devices: DeviceRecord[]
  entitlements: Entitlements
}

/** One session, addressed by the SHA-256 of the token. */
export interface SessionRecord {
  readonly tokenHash: string
  readonly userId: string
  readonly deviceId: string
  readonly createdAt: number
  lastSeenAt: number
  revokedAt: number | null
  revokedReason: string | null
}

/** A binding from Apple's stable subscription identity to one account. */
export interface AppStoreBinding {
  readonly originalTransactionId: string
  readonly userId: string
}

/** The persistent account file. */
export interface AccountsFile {
  version: 1
  users: UserRecord[]
  sessions: SessionRecord[]
  appStoreBindings: AppStoreBinding[]
  processedAppStoreEvents: string[]
}

/** One invite code. */
export interface InviteRecord {
  readonly code: string
  readonly codeKey: string
  readonly days: number
  readonly maxUses: number
  uses: number
  readonly expiresAt: number | null
  disabled: boolean
  readonly createdAt: number
  readonly redemptions: Array<{ userId: string; at: number }>
}

/** The persistent invite file. */
export interface InvitesFile {
  version: 1
  codes: InviteRecord[]
}

/** Public device shape. */
export interface PublicDevice {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly platform: string
  loginAt: number
  readonly lastSeenAt: number
  readonly current: boolean
}

/** Public App Store entitlement shape. */
export interface PublicAppStore {
  readonly paidUntil: number | null
  readonly productId: string
  readonly environment: string
  readonly autoRenew: boolean
  readonly revokedAt: number | null
}

/** The user object the phone and the admin UI read. */
export interface PublicUser {
  readonly id: string
  readonly username: string
  readonly email: string | null
  emailVerified: boolean
  readonly plan: 'free' | 'paid'
  readonly paidUntil: number | null
  readonly paidSources: readonly ('invite' | 'admin' | 'appstore')[]
  readonly grantedPaidUntil: number | null
  readonly appStore: PublicAppStore | null
  readonly avatar: AvatarSpec
  /** Whether the account is linked to Sign in with Apple. */
  readonly apple: boolean
  /** Whether the account is linked to GitHub. */
  readonly github: boolean
  /** The GitHub handle the account is linked to, when it is. */
  readonly githubLogin: string | null
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly devices: readonly PublicDevice[]
}

/** A notice returned beside a successful login. */
export interface AccountNotice {
  readonly code: 'DEVICE_LIMIT'
  readonly revokedDevice: string
}

/**
 * What one session token resolves to.
 *
 * The paid gate asks this on every relayed request, so it is a value rather
 * than an exception: "not signed in", "signed out elsewhere", "expired",
 * "disabled" and "signed in but not paying" are five different answers on the
 * wire, and a phone acts differently on each of them.
 */
export type TokenEntitlement =
  | {
      readonly ok: true
      readonly userId: string
      /** End of the paid period, or `null` when there is none. */
      readonly paidUntil: number | null
      /** Whether the period is still running at the time of the check. */
      readonly paid: boolean
    }
  | {
      readonly ok: false
      readonly reason: 'unknown' | 'revoked' | 'expired' | 'disabled'
    }

/** What a login/register/apple call returns. */
export interface AuthResult {
  readonly token: string
  readonly user: PublicUser
  readonly notice?: AccountNotice
}

/** A verified GitHub identity, as the OAuth half reports it. */
export interface GitHubIdentity {
  /** GitHub's stable numeric account id, as a string. */
  readonly id: string
  /** The handle, which the user may rename at will. */
  readonly login: string
  /** A **verified** email, when GitHub carries one; never an unverified claim. */
  readonly email: string | null
  /** Always `true` when `email` is set. */
  readonly emailVerified: boolean
}

/** A device descriptor sent by the app. */
export interface DeviceInput {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly platform: string
  readonly appVersion: string
}

/** The account service's runtime knobs. */
export interface AccountStoreOptions {
  /** Directory holding the JSON files. */
  readonly dataDir: string
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number
  /** Password cost, injectable for faster tests. */
  readonly passwordParams?: import('./passwords.js').ScryptParams
  /** Fetch implementation for Gravatar/Apple; injectable for tests. */
  readonly fetchImpl?: typeof fetch
  /** Gravatar policy. */
  readonly gravatar: {
    readonly enabled: boolean
    readonly baseURLs: readonly string[]
  }
  /** Apple identity-token verification. */
  readonly apple: {
    readonly audiences: readonly string[]
    readonly keysURL: string
  }
  /** App Store subscription verification. */
  readonly appstore: {
    readonly bundleId: string
    readonly productId: string
    readonly allowSandbox: boolean
  }
  /** Optional logger. */
  readonly log?: (message: string) => void
}

/** The result of a failed account operation. */
export class AccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AccountError'
  }
}
