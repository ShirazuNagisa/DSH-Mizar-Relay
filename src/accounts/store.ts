/**
 * The account store: every read and write the account service performs.
 *
 * One process, one JSON file, one mutation queue. The store is intentionally
 * synchronous in its in-memory state and async only at the persistence
 * boundary: a login is a handful of map lookups plus one scrypt call, and
 * turning every lookup into an await would buy nothing at this size.
 *
 * @module dsh-mizar-relay/accounts/store
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppleIdentityVerifier } from './apple.js'
import { avatarFor, generatedAvatar, normalizeEmail } from './avatar.js'
import { applyNotification, applyTransaction, effectivePaidUntil, publicUser } from './appstore/entitlements.js'
import { AppStoreVerifier, type TransactionPolicy, type VerifiedTransaction } from './appstore/verify.js'
import { burnPasswordCheck, hashPassword, verifyPassword, DEFAULT_SCRYPT, type ScryptParams } from './passwords.js'
import { backupFile, ensurePrivateDir, MutationQueue, readJsonFile, writeJsonAtomic } from './state.js'
import { AccountError } from './types.js'
import type {
  AccountNotice,
  AccountsFile,
  AuthResult,
  DeviceInput,
  DeviceRecord,
  Entitlements,
  InviteRecord,
  InvitesFile,
  PublicUser,
  SessionRecord,
  TokenEntitlement,
  UserRecord,
} from './types.js'

/**
 * How long a session token is valid.
 *
 * A phone that has not opened the app in half a year signs in again, which is
 * also the only way a token that leaked from a backup stops working on its own.
 */
const SESSION_MAX_AGE_MS = 180 * 86_400_000

/** Everything the store needs at open. */
export interface AccountStoreOptions {
  /** Directory holding the JSON files. */
  readonly dataDir: string
  /** Clock, injectable for deterministic tests. */
  readonly now?: () => number
  /** Password cost, injectable for faster tests. */
  readonly passwordParams?: ScryptParams
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
  /** App Store verification policy. */
  readonly appstore: {
    readonly bundleId: string
    readonly productId: string
    readonly allowSandbox: boolean
  }
  /** Trusted App Store roots, base64 DER. Tests inject a local chain. */
  readonly appstoreRoots?: readonly string[]
  /** Where the audit log lives, relative to `dataDir`. */
  readonly log?: (message: string) => void
}

/** A validated registration request. */
export interface RegisterInput {
  readonly username: string
  readonly email: string
  readonly password: string
  readonly device: DeviceInput
}

/** A validated login request. */
export interface LoginInput {
  readonly identifier: string
  readonly password: string
  readonly device: DeviceInput
}

/** A validated Apple sign-in request. */
export interface AppleSignInInput {
  readonly identityToken: string
  readonly nonce?: string
  readonly device: DeviceInput
  readonly fullName?: string
}

/** Admin pagination. */
export interface UserPage {
  readonly users: UserRecord[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

/** Create an invite code. */
export interface CreateInviteInput {
  readonly code?: string
  readonly days: number
  readonly maxUses: number
  readonly expiresAt: number | null
}

/** The account store. */
export class AccountStore {
  readonly #dir: string
  readonly #accountsPath: string
  readonly #invitesPath: string
  readonly #auditPath: string
  readonly #now: () => number
  readonly #passwordParams: ScryptParams
  readonly #fetch: typeof fetch
  readonly #gravatar: AccountStoreOptions['gravatar']
  readonly #appleVerifier: AppleIdentityVerifier
  readonly #appStoreVerifier: AppStoreVerifier
  readonly #appstorePolicy: TransactionPolicy
  readonly #log: (message: string) => void
  readonly #queue = new MutationQueue()
  readonly #users = new Map<string, UserRecord>()
  readonly #sessions: SessionRecord[] = []
  /**
   * Sessions by token hash.
   *
   * The array is what gets persisted and iterated for per-user queries; this map
   * is what the paid gate reads, because it runs on every relayed request and a
   * linear scan over every session ever issued is not a per-request cost.
   */
  readonly #sessionsByHash = new Map<string, SessionRecord>()
  readonly #bindings = new Map<string, string>()
  readonly #processed = new Set<string>()
  readonly #invites = new Map<string, InviteRecord>()
  #onDeleteUserHashes: ((hashes: readonly string[]) => void) | null = null
  #onEntitlementsChanged: ((userId: string) => void) | null = null
  #closed = false

  /** Remember one idempotency key, capped so the file cannot grow forever. */
  #rememberProcessed(key: string): void {
    this.#processed.add(key)
    if (this.#processed.size > 10_000) {
      const oldest = this.#processed.values().next().value
      if (typeof oldest === 'string') this.#processed.delete(oldest)
    }
  }

  private constructor(options: AccountStoreOptions) {
    this.#dir = options.dataDir
    this.#accountsPath = join(this.#dir, 'accounts.json')
    this.#invitesPath = join(this.#dir, 'invites.json')
    this.#auditPath = join(this.#dir, 'audit.log')
    this.#now = options.now ?? Date.now
    this.#passwordParams = options.passwordParams ?? DEFAULT_SCRYPT
    this.#fetch = options.fetchImpl ?? fetch
    this.#gravatar = options.gravatar
    this.#log = options.log ?? (() => undefined)
    this.#appleVerifier = new AppleIdentityVerifier({
      audiences: options.apple.audiences,
      keysURL: options.apple.keysURL,
      fetchImpl: this.#fetch,
      now: this.#now,
    })
    this.#appStoreVerifier = new AppStoreVerifier({
      roots: options.appstoreRoots,
      now: this.#now,
    })
    this.#appstorePolicy = {
      bundleId: options.appstore.bundleId,
      productId: options.appstore.productId,
      allowSandbox: options.appstore.allowSandbox,
    }
  }

  /**
   * Open (or create) the data directory and load the two state files.
   *
   * @param options - configuration and injectable dependencies.
   * @returns the store.
   * @throws when an existing state file is corrupt, so an upgrade cannot silently
   *   replace every account with an empty database.
   */
  static async open(options: AccountStoreOptions): Promise<AccountStore> {
    const store = new AccountStore(options)
    await ensurePrivateDir(store.#dir)
    await backupFile(store.#accountsPath)
    await backupFile(store.#invitesPath)
    const accounts = await readJsonFile<AccountsFile | null>(store.#accountsPath, null)
    if (accounts !== null) store.#loadAccounts(accounts)
    const invites = await readJsonFile<InvitesFile | null>(store.#invitesPath, null)
    if (invites !== null) store.#loadInvites(invites)
    return store
  }

  /** How many accounts are stored. */
  get userCount(): number {
    return this.#users.size
  }

  /** How many invite codes are stored. */
  get inviteCount(): number {
    return this.#invites.size
  }

  /** The store's clock, for the admin pages. */
  get currentTime(): number {
    return this.#now()
  }

  /** Register the traffic ledger's cleanup hook for account deletion. */
  setTrafficRemover(remover: (hashes: readonly string[]) => void): void {
    this.#onDeleteUserHashes = remover
  }

  /**
   * Register the paid gate's cache-invalidation hook.
   *
   * Without it a refund, a revoked device or an admin's downgrade would keep
   * working until the gate's cache entry expired. The hook makes those changes
   * take effect on the next request instead, which is what an operator who just
   * took somebody's access away expects.
   *
   * @param listener - called with the account id whose access changed.
   */
  setEntitlementListener(listener: (userId: string) => void): void {
    this.#onEntitlementsChanged = listener
  }

  /** Tell the gate that one account's access may have changed. */
  #entitlementsChanged(userId: string): void {
    this.#onEntitlementsChanged?.(userId)
  }

  /**
   * Resolve a raw session token to its account's paid state.
   *
   * Deliberately synchronous and side-effect free: it runs before a relayed
   * request is forwarded, so it must not touch the disk, the mutation queue or
   * `lastSeenAt`. `/me` remains the endpoint that records activity.
   *
   * @param token - the session token as the phone presented it.
   * @returns the entitlement, or why the token is not usable.
   */
  tokenEntitlement(token: string): TokenEntitlement {
    if (typeof token !== 'string' || token === '') return { ok: false, reason: 'unknown' }
    const session = this.#sessionsByHash.get(hashToken(token))
    if (session === undefined) return { ok: false, reason: 'unknown' }
    if (session.revokedAt !== null) return { ok: false, reason: 'revoked' }
    const now = this.#now()
    if (now - session.createdAt > SESSION_MAX_AGE_MS) return { ok: false, reason: 'expired' }
    const user = this.#users.get(session.userId)
    if (user === undefined) return { ok: false, reason: 'unknown' }
    if (user.disabled) return { ok: false, reason: 'disabled' }
    const paidUntil = effectivePaidUntil(user)
    return { ok: true, userId: user.id, paidUntil, paid: paidUntil !== null && paidUntil > now }
  }

  /** Every session token hash this user has ever had, for traffic lookup. */
  sessionHashesForUser(userId: string): string[] {
    return this.#sessions.filter((session) => session.userId === userId).map((session) => session.tokenHash)
  }

  // MARK: - Authentication

  /**
   * Register a username/email/password account.
   *
   * @param input - validated registration fields.
   * @returns the session token and public user.
   */
  async register(input: RegisterInput): Promise<AuthResult> {
    const username = validateUsername(input.username)
    const email = validateEmail(input.email)
    validatePassword(input.password)
    const device = validateDevice(input.device)
    const now = this.#now()
    const usernameKey = username.toLowerCase()
    const emailKey = normalizeEmail(email)
    const user = await this.#queue.run(async () => {
      if (this.#findByUsernameKey(usernameKey) !== undefined) {
        throw new AccountError('USERNAME_TAKEN', 'that username is already in use', 409)
      }
      if (this.#findByEmailKey(emailKey) !== undefined) {
        throw new AccountError('EMAIL_TAKEN', 'that email is already registered', 409)
      }
      const passwordHash = await hashPassword(input.password, this.#passwordParams)
      // A Gravatar lookup is awaited so the registration response already has
      // the final avatar; the timeout cap in `avatarFor` bounds the cost.
      const avatar = await avatarFor(email, username, {
        enabled: this.#gravatar.enabled,
        baseURLs: this.#gravatar.baseURLs,
        fetchImpl: this.#fetch,
      })
      const record: UserRecord = {
        id: randomUUID(),
        username,
        usernameKey,
        email,
        emailKey,
        emailVerified: false,
        passwordHash,
        appleSub: null,
        avatar,
        disabled: false,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        devices: [],
        entitlements: { grantedPaidUntil: null, appStore: null },
      }
      this.#users.set(record.id, record)
      this.#indexes(record)
      const issued = this.#issueSession(record, device, now, true)
      await this.#saveAccounts()
      return { token: issued.token, user: this.#public(record, device.id, now), ...(issued.notice === undefined ? {} : { notice: issued.notice }) }
    })
    return user
  }

  /**
   * Log in with an email or username.
   *
   * @param input - identifier, password, device.
   * @returns the session token and public user.
   */
  async login(input: LoginInput): Promise<AuthResult> {
    const identifier = input.identifier.trim()
    if (identifier === '') throw new AccountError('INVALID_INPUT', 'identifier is required', 400)
    validatePasswordShape(input.password)
    const device = validateDevice(input.device)
    const now = this.#now()
    return this.#queue.run(async () => {
      const user =
        this.#findByEmailKey(normalizeEmail(identifier)) ?? this.#findByUsernameKey(identifier.toLowerCase())
      if (user === undefined) {
        await burnPasswordCheck(input.password, this.#passwordParams)
        throw new AccountError('UNAUTHENTICATED', 'identifier or password is not right', 401)
      }
      if (user.disabled) throw new AccountError('ACCOUNT_DISABLED', 'this account is disabled', 403)
      const ok = user.passwordHash !== null && (await verifyPassword(input.password, user.passwordHash))
      if (!ok) throw new AccountError('UNAUTHENTICATED', 'identifier or password is not right', 401)
      user.lastSeenAt = now
      user.updatedAt = now
      const issued = this.#issueSession(user, device, now, user.appleSub === null)
      // A new sign-in can revoke the oldest device's session, and the gate may
      // be holding that token as allowed.
      this.#entitlementsChanged(user.id)
      await this.#saveAccounts()
      return { token: issued.token, user: this.#public(user, device.id, now), ...(issued.notice === undefined ? {} : { notice: issued.notice }) }
    })
  }

  /**
   * Sign in (or sign up) with a verified Apple identity.
   *
   * @param input - identity token, nonce, device.
   * @returns the session token and public user.
   */
  async signInWithApple(input: AppleSignInInput): Promise<AuthResult> {
    const identity = await this.#appleVerifier.verify(input.identityToken, input.nonce)
    const device = validateDevice(input.device)
    const now = this.#now()
    return this.#queue.run(async () => {
      let user = this.#findByAppleSub(identity.sub)
      if (user === undefined && identity.email !== null && identity.emailVerified) {
        const existing = this.#findByEmailKey(normalizeEmail(identity.email))
        if (existing !== undefined && existing.appleSub === null) {
          existing.appleSub = identity.sub
          existing.emailVerified = true
          existing.updatedAt = now
          user = existing
        }
      }
      if (user === undefined) {
        const email = identity.email
        const username = this.#uniqueUsername(deriveUsername(input.fullName, email, identity.sub))
        const name = input.fullName?.trim() || username
        const avatar = await avatarFor(email, name, {
          enabled: this.#gravatar.enabled,
          baseURLs: this.#gravatar.baseURLs,
          fetchImpl: this.#fetch,
          seed: email ?? identity.sub,
        })
        user = {
          id: randomUUID(),
          username,
          usernameKey: username.toLowerCase(),
          email,
          emailKey: email === null ? null : normalizeEmail(email),
          emailVerified: identity.emailVerified,
          passwordHash: null,
          appleSub: identity.sub,
          avatar,
          disabled: false,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          devices: [],
          entitlements: { grantedPaidUntil: null, appStore: null },
        }
        this.#users.set(user.id, user)
        this.#indexes(user)
      }
      if (user.disabled) throw new AccountError('ACCOUNT_DISABLED', 'this account is disabled', 403)
      user.lastSeenAt = now
      user.updatedAt = now
      const issued = this.#issueSession(user, device, now, false)
      this.#entitlementsChanged(user.id)
      await this.#saveAccounts()
      return { token: issued.token, user: this.#public(user, device.id, now), ...(issued.notice === undefined ? {} : { notice: issued.notice }) }
    })
  }

  /**
   * Read the current user.
   *
   * @param token - raw session token.
   * @param currentDeviceId - the device making the request.
   * @returns the public user.
   */
  async me(token: string, currentDeviceId: string | null): Promise<PublicUser> {
    const now = this.#now()
    const session = this.#authenticate(token)
    const user = this.#users.get(session.userId)
    if (user === undefined) throw new AccountError('UNAUTHENTICATED', 'this account no longer exists', 401)
    if (user.disabled) throw new AccountError('ACCOUNT_DISABLED', 'this account is disabled', 403)
    // Throttle the write: a phone switching apps calls `/me` more often than a
    // second-level timestamp is useful, and every write is a whole file.
    if (now - session.lastSeenAt > 60_000 || now - user.lastSeenAt > 60_000) {
      session.lastSeenAt = now
      user.lastSeenAt = now
      const device = user.devices.find((candidate) => candidate.id === session.deviceId)
      if (device !== undefined) device.lastSeenAt = now
      await this.#queue.run(() => this.#saveAccounts())
    }
    return this.#public(user, currentDeviceId ?? session.deviceId, now)
  }

  /** Log the current session out. */
  async logout(token: string): Promise<void> {
    const now = this.#now()
    const session = this.#authenticate(token)
    await this.#queue.run(async () => {
      session.revokedAt = now
      session.revokedReason = 'logout'
      const user = this.#users.get(session.userId)
      const device = user?.devices.find((candidate) => candidate.id === session.deviceId)
      if (device !== undefined) device.revokedAt = now
      this.#entitlementsChanged(session.userId)
      await this.#saveAccounts()
    })
  }

  /**
   * Delete the account and its personal data.
   *
   * The subscription is not cancelled: only Apple can do that. The app warns the
   * user before calling this.
   */
  async deleteAccount(token: string): Promise<void> {
    const now = this.#now()
    const session = this.#authenticate(token)
    await this.#queue.run(async () => {
      const hashes = this.sessionHashesForUser(session.userId)
      const user = this.#users.get(session.userId)
      this.#users.delete(session.userId)
      for (const candidate of [...this.#sessions]) {
        if (candidate.userId !== session.userId) continue
        candidate.revokedAt = now
        candidate.revokedReason = 'account-deleted'
      }
      for (const [original, userId] of this.#bindings) {
        if (userId === session.userId) this.#bindings.delete(original)
      }
      if (user !== undefined) {
        this.#users.delete(user.id)
      }
      await this.#saveAccounts()
      this.#onDeleteUserHashes?.(hashes)
      this.#entitlementsChanged(session.userId)
      await this.#audit('account-deleted', { userId: session.userId })
    })
  }

  // MARK: - Invites and admin grants

  /**
   * Redeem one invite code against the current account.
   *
   * @param token - session token.
   * @param code - the code as typed.
   * @returns the updated public user.
   */
  async redeemInvite(token: string, code: string): Promise<PublicUser> {
    const now = this.#now()
    const session = this.#authenticate(token)
    const normalized = normalizeInviteCode(code)
    return this.#queue.run(async () => {
      const invite = this.#invites.get(normalized)
      if (invite === undefined) throw new AccountError('INVITE_INVALID', 'that invite code is not valid', 400)
      if (invite.disabled) throw new AccountError('INVITE_INVALID', 'that invite code is disabled', 400)
      if (invite.expiresAt !== null && invite.expiresAt <= now) {
        throw new AccountError('INVITE_EXPIRED', 'that invite code has expired', 400)
      }
      if (invite.uses >= invite.maxUses) {
        throw new AccountError('INVITE_USED_UP', 'that invite code has no uses left', 400)
      }
      const user = this.#users.get(session.userId)
      if (user === undefined) throw new AccountError('UNAUTHENTICATED', 'this account no longer exists', 401)
      if (user.disabled) throw new AccountError('ACCOUNT_DISABLED', 'this account is disabled', 403)
      const base = Math.max(now, user.entitlements.grantedPaidUntil ?? 0)
      user.entitlements.grantedPaidUntil = base + invite.days * 86_400_000
      user.updatedAt = now
      invite.uses += 1
      invite.redemptions.push({ userId: user.id, at: now })
      this.#entitlementsChanged(user.id)
      await this.#saveAccounts()
      await this.#saveInvites()
      await this.#audit('invite-redeemed', { code: invite.code, userId: user.id, days: invite.days })
      return this.#public(user, session.deviceId, now)
    })
  }

  /** Admin: set or clear the manual grant. */
  async setGrant(userId: string, days: number | null): Promise<PublicUser> {
    const now = this.#now()
    return this.#queue.run(async () => {
      const user = this.#users.get(userId)
      if (user === undefined) throw new AccountError('INVALID_INPUT', 'no such account', 404)
      user.entitlements.grantedPaidUntil =
        days === null ? null : Math.max(now, user.entitlements.grantedPaidUntil ?? 0) + days * 86_400_000
      user.updatedAt = now
      this.#entitlementsChanged(userId)
      await this.#saveAccounts()
      await this.#audit('grant-changed', { userId, days })
      return this.#public(user, null, now)
    })
  }

  /** Admin: disable or enable an account, revoking sessions on disable. */
  async setDisabled(userId: string, disabled: boolean): Promise<PublicUser> {
    const now = this.#now()
    return this.#queue.run(async () => {
      const user = this.#users.get(userId)
      if (user === undefined) throw new AccountError('INVALID_INPUT', 'no such account', 404)
      user.disabled = disabled
      user.updatedAt = now
      if (disabled) {
        for (const session of this.#sessions) {
          if (session.userId === userId) {
            session.revokedAt = now
            session.revokedReason = 'account-disabled'
          }
        }
      }
      await this.#saveAccounts()
      await this.#audit('account-disabled', { userId, disabled })
      this.#entitlementsChanged(userId)
      return this.#public(user, null, now)
    })
  }

  /** Admin: revoke one device's sessions. */
  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    const now = this.#now()
    return this.#queue.run(async () => {
      const user = this.#users.get(userId)
      if (user === undefined) return false
      const device = user.devices.find((candidate) => candidate.id === deviceId)
      if (device === undefined) return false
      device.revokedAt = now
      let revoked = false
      for (const session of this.#sessions) {
        if (session.userId === userId && session.deviceId === deviceId && session.revokedAt === null) {
          session.revokedAt = now
          session.revokedReason = 'device-revoked'
          revoked = true
        }
      }
      await this.#saveAccounts()
      await this.#audit('device-revoked', { userId, deviceId })
      if (revoked) this.#entitlementsChanged(userId)
      return revoked
    })
  }

  // MARK: - App Store

  /**
   * Record one StoreKit transaction.
   *
   * @param token - session token.
   * @param signedTransaction - `Transaction.jsonRepresentation`.
   * @returns the updated public user.
   */
  async appStoreTransaction(token: string, signedTransaction: string): Promise<PublicUser> {
    const session = this.#authenticate(token)
    const now = this.#now()
    const transaction = this.#appStoreVerifier.verifyTransaction(signedTransaction, this.#appstorePolicy)
    return this.#queue.run(async () => {
      const user = this.#users.get(session.userId)
      if (user === undefined) throw new AccountError('UNAUTHENTICATED', 'this account no longer exists', 401)
      this.#claimTransaction(user, transaction, now, true)
      if (this.#processed.has(transaction.transactionId)) {
        return this.#public(user, session.deviceId, now)
      }
      applyTransaction(user, transaction, now)
      this.#rememberProcessed(transaction.transactionId)
      this.#entitlementsChanged(user.id)
      await this.#saveAccounts()
      await this.#audit('appstore-transaction', {
        userId: user.id,
        transactionId: transaction.transactionId,
        environment: transaction.environment,
      })
      return this.#public(user, session.deviceId, now)
    })
  }

  /**
   * Reconcile a batch of StoreKit transactions (restore, launch, renewal).
   *
   * @param token - session token.
   * @param signedTransactions - up to 100 compact JWS from StoreKit.
   * @returns the updated public user.
   */
  async appStoreSync(token: string, signedTransactions: readonly string[]): Promise<PublicUser> {
    const session = this.#authenticate(token)
    if (signedTransactions.length === 0 || signedTransactions.length > 100) {
      throw new AccountError('INVALID_INPUT', 'provide between 1 and 100 transactions', 400)
    }
    const now = this.#now()
    const transactions = signedTransactions.map((signed) =>
      this.#appStoreVerifier.verifyTransaction(signed, this.#appstorePolicy),
    )
    return this.#queue.run(async () => {
      const user = this.#users.get(session.userId)
      if (user === undefined) throw new AccountError('UNAUTHENTICATED', 'this account no longer exists', 401)
      for (const transaction of transactions) this.#claimTransaction(user, transaction, now, true)
      // Old transactions first, so the newest expiry wins and a revocation of
      // an older period cannot cancel the latest one.
      for (const transaction of [...transactions].sort((a, b) => a.expiresDate - b.expiresDate)) {
        if (this.#processed.has(transaction.transactionId)) continue
        applyTransaction(user, transaction, now)
        this.#rememberProcessed(transaction.transactionId)
      }
      await this.#saveAccounts()
      await this.#audit('appstore-sync', { userId: user.id, count: transactions.length })
      this.#entitlementsChanged(user.id)
      return this.#public(user, session.deviceId, now)
    })
  }

  /**
   * Handle an App Store Server Notification V2.
   *
   * @param signedPayload - Apple's outer JWS.
   * @returns whether a user was found and updated.
   */
  async appStoreNotification(signedPayload: string): Promise<boolean> {
    const now = this.#now()
    const notification = this.#appStoreVerifier.verifyNotification(signedPayload, this.#appstorePolicy)
    const transaction = notification.transaction
    if (notification.notificationUUID !== null && this.#processed.has(notification.notificationUUID)) {
      return true
    }
    return this.#queue.run(async () => {
      const user = this.#findNotificationUser(notification, now)
      if (user === undefined) {
        this.#log(
          `accounts: App Store notification ${notification.notificationType} matched no account`,
        )
        return false
      }
      if (transaction !== null) this.#claimTransaction(user, transaction, now, false)
      applyNotification(user, notification, now)
      if (notification.notificationUUID !== null) {
        this.#rememberProcessed(notification.notificationUUID)
      }
      await this.#saveAccounts()
      await this.#audit('appstore-notification', {
        userId: user.id,
        type: notification.notificationType,
      })
      this.#entitlementsChanged(user.id)
      return true
    })
  }

  // MARK: - Admin reads

  /** Every stored user, for the admin pages. */
  allUsers(): UserRecord[] {
    return [...this.#users.values()]
  }

  /** One stored user. */
  findUser(userId: string): UserRecord | undefined {
    return this.#users.get(userId)
  }

  /** Search/paginate users. */
  listUsers(query: string, page: number, pageSize: number): UserPage {
    const needle = query.trim().toLowerCase()
    const matched = this.allUsers().filter((user) => {
      if (needle === '') return true
      return (
        user.username.toLowerCase().includes(needle) ||
        (user.email ?? '').toLowerCase().includes(needle) ||
        user.id.includes(needle)
      )
    })
    const size = Math.max(1, Math.min(100, pageSize))
    const pages = Math.max(1, Math.ceil(matched.length / size))
    const current = Math.max(1, Math.min(pages, page))
    return {
      users: matched.slice((current - 1) * size, current * size),
      total: matched.length,
      page: current,
      pageSize: size,
    }
  }

  /** Every invite code. */
  allInvites(): InviteRecord[] {
    return [...this.#invites.values()]
  }

  /** Create an invite code. */
  async createInvite(input: CreateInviteInput): Promise<InviteRecord> {
    const days = Math.round(input.days)
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      throw new AccountError('INVALID_INPUT', 'days must be between 1 and 3650', 400)
    }
    const maxUses = Math.round(input.maxUses)
    if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 1000) {
      throw new AccountError('INVALID_INPUT', 'maxUses must be between 1 and 1000', 400)
    }
    const code = input.code === undefined || input.code.trim() === '' ? generateInviteCode() : normalizeInviteCode(input.code)
    // A custom code is a capability: whoever types it collects paid days. The
    // generated ones are twelve base32 characters, which is 60 bits and cannot
    // be guessed; a custom one has to be held to the same bar or it becomes the
    // cheapest way to mint free entitlements. Eight characters of this alphabet
    // is 40 bits -- enough that a redeem endpoint limited to a handful of tries
    // a minute cannot be walked -- and the alphabet excludes the letters a
    // person confuses, so a code read aloud still works.
    if (!/^[A-Z0-9_-]{8,64}$/.test(code)) {
      throw new AccountError(
        'INVALID_INPUT',
        'invite codes are 8-64 characters of A-Z, 0-9, _ and -',
        400,
      )
    }
    const now = this.#now()
    return this.#queue.run(async () => {
      if (this.#invites.has(code)) throw new AccountError('INVALID_INPUT', 'that invite code already exists', 409)
      const invite: InviteRecord = {
        code,
        codeKey: code,
        days,
        maxUses,
        uses: 0,
        expiresAt: input.expiresAt,
        disabled: false,
        createdAt: now,
        redemptions: [],
      }
      this.#invites.set(code, invite)
      await this.#saveInvites()
      await this.#audit('invite-created', { code, days, maxUses })
      return invite
    })
  }

  /** Enable or disable an invite code. */
  async setInviteDisabled(code: string, disabled: boolean): Promise<boolean> {
    const key = normalizeInviteCode(code)
    return this.#queue.run(async () => {
      const invite = this.#invites.get(key)
      if (invite === undefined) return false
      invite.disabled = disabled
      await this.#saveInvites()
      await this.#audit('invite-disabled', { code: key, disabled })
      return true
    })
  }

  /** Delete an invite code. */
  async deleteInvite(code: string): Promise<boolean> {
    const key = normalizeInviteCode(code)
    return this.#queue.run(async () => {
      const deleted = this.#invites.delete(key)
      if (deleted) {
        await this.#saveInvites()
        await this.#audit('invite-deleted', { code: key })
      }
      return deleted
    })
  }

  /** Flush and stop. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#queue.run(async () => {
      await this.#saveAccounts()
      await this.#saveInvites()
    })
  }

  // MARK: - Internals

  /** Load and index the account file. */
  #loadAccounts(file: AccountsFile): void {
    if (file.version !== 1) throw new Error(`unsupported accounts.json version ${String(file.version)}`)
    for (const user of file.users ?? []) {
      this.#users.set(user.id, user)
      this.#indexes(user)
    }
    for (const session of file.sessions ?? []) {
      this.#sessions.push(session)
      this.#sessionsByHash.set(session.tokenHash, session)
    }
    for (const binding of file.appStoreBindings ?? []) {
      this.#bindings.set(binding.originalTransactionId, binding.userId)
    }
    for (const event of file.processedAppStoreEvents ?? []) this.#processed.add(event)
  }

  /** Load and index the invite file. */
  #loadInvites(file: InvitesFile): void {
    if (file.version !== 1) throw new Error(`unsupported invites.json version ${String(file.version)}`)
    for (const invite of file.codes ?? []) this.#invites.set(invite.codeKey, invite)
  }

  /** The indexes are rebuilt by looking up the maps; the only index we need is
   * email/username, and a linear scan over a few thousand users is simpler and
   * less error-prone than keeping three maps in sync. */
  #indexes(_user: UserRecord): void {
    void _user
  }

  /** Find by username key. */
  #findByUsernameKey(key: string): UserRecord | undefined {
    for (const user of this.#users.values()) if (user.usernameKey === key) return user
    return undefined
  }

  /** Find by email key. */
  #findByEmailKey(key: string): UserRecord | undefined {
    for (const user of this.#users.values()) if (user.emailKey === key) return user
    return undefined
  }

  /** Find by Apple subject. */
  #findByAppleSub(sub: string): UserRecord | undefined {
    for (const user of this.#users.values()) if (user.appleSub === sub) return user
    return undefined
  }

  /** Make a username unique by appending a numeric suffix. */
  #uniqueUsername(base: string): string {
    let candidate = base
    let suffix = 2
    while (this.#findByUsernameKey(candidate.toLowerCase()) !== undefined) {
      candidate = `${base.slice(0, 28)}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  /**
   * Create one session for a device.
   *
   * The same device replaces its old session; a password-only account over the
   * device cap loses its oldest device. Apple-linked accounts never hit the cap.
   */
  #issueSession(
    user: UserRecord,
    device: DeviceInput,
    now: number,
    enforceLimit: boolean,
  ): { token: string; notice?: AccountNotice } {
    let record = user.devices.find((candidate) => candidate.id === device.id)
    if (record === undefined) {
      record = {
        id: device.id,
        name: device.name,
        model: device.model,
        platform: device.platform,
        appVersion: device.appVersion,
        loginAt: now,
        lastSeenAt: now,
        revokedAt: null,
      }
      user.devices.push(record)
    } else {
      record.loginAt = now
      record.lastSeenAt = now
      record.revokedAt = null
    }
    for (const session of this.#sessions) {
      if (session.userId === user.id && session.deviceId === device.id && session.revokedAt === null) {
        session.revokedAt = now
        session.revokedReason = 'signed-in-again'
      }
    }
    const token = `mza_${randomBytes(32).toString('base64url')}`
    const issued: SessionRecord = {
      tokenHash: hashToken(token),
      userId: user.id,
      deviceId: device.id,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      revokedReason: null,
    }
    this.#sessions.push(issued)
    this.#sessionsByHash.set(issued.tokenHash, issued)
    let notice: AccountNotice | undefined
    if (enforceLimit && user.appleSub === null) {
      const activeDevices = [...new Set(
        this.#sessions
          .filter((session) => session.userId === user.id && session.revokedAt === null)
          .map((session) => session.deviceId),
      )]
      if (activeDevices.length > 2) {
        const oldest = activeDevices
          .map((id) => user.devices.find((candidate) => candidate.id === id))
          .filter((candidate): candidate is DeviceRecord => candidate !== undefined)
          .sort((a, b) => a.loginAt - b.loginAt)[0]
        if (oldest !== undefined && oldest.id !== device.id) {
          for (const session of this.#sessions) {
            if (session.userId === user.id && session.deviceId === oldest.id && session.revokedAt === null) {
              session.revokedAt = now
              session.revokedReason = 'device-limit'
            }
          }
          oldest.revokedAt = now
          notice = { code: 'DEVICE_LIMIT', revokedDevice: oldest.name }
        }
      }
    }
    return { token, ...(notice === undefined ? {} : { notice }) }
  }

  /** Authenticate a token and return its live session. */
  #authenticate(token: string): SessionRecord {
    if (typeof token !== 'string' || token === '') {
      throw new AccountError('UNAUTHENTICATED', 'a session token is required', 401)
    }
    const hash = hashToken(token)
    const session = this.#sessions.find((candidate) => candidate.tokenHash === hash)
    if (session === undefined) throw new AccountError('UNAUTHENTICATED', 'this session is not valid', 401)
    if (session.revokedAt !== null) {
      throw new AccountError('SESSION_REVOKED', 'this session was signed out elsewhere', 401)
    }
    const now = this.#now()
    if (now - session.createdAt > SESSION_MAX_AGE_MS) {
      session.revokedAt = now
      session.revokedReason = 'expired'
      throw new AccountError('UNAUTHENTICATED', 'this session has expired', 401)
    }
    return session
  }

  /** Bind a transaction to a user, or verify an existing binding. */
  #claimTransaction(
    user: UserRecord,
    transaction: VerifiedTransaction,
    now: number,
    requireAccountToken: boolean,
  ): void {
    const bound = this.#bindings.get(transaction.originalTransactionId)
    if (bound !== undefined && bound !== user.id) {
      throw new AccountError(
        'APPSTORE_ACCOUNT_MISMATCH',
        'this subscription is already bound to another account',
        409,
      )
    }
    if (transaction.appAccountToken === null) {
      // A notification for a purchase made outside the app may omit the token.
      // It is only accepted when the original transaction is already bound to
      // this user; a first-time claim must always name the account.
      if (bound !== user.id || requireAccountToken) {
        throw new AccountError(
          'APPSTORE_ACCOUNT_MISMATCH',
          'this purchase was made for another account',
          409,
        )
      }
    } else if (transaction.appAccountToken !== user.id) {
      throw new AccountError(
        'APPSTORE_ACCOUNT_MISMATCH',
        'this purchase was made for another account',
        409,
      )
    }
    if (bound === undefined) {
      this.#bindings.set(transaction.originalTransactionId, user.id)
    }
    if (transaction.revocationDate !== null && transaction.revocationDate <= now) {
      // A revoked transaction is still recorded so an audit trail exists.
    }
  }

  /** Find the user a notification belongs to. */
  #findNotificationUser(
    notification: { transaction: VerifiedTransaction | null; renewal: Record<string, unknown> | null },
    now: number,
  ): UserRecord | undefined {
    void now
    if (notification.transaction?.appAccountToken !== null && notification.transaction?.appAccountToken !== undefined) {
      return this.#users.get(notification.transaction.appAccountToken)
    }
    if (notification.transaction !== null) {
      const userId = this.#bindings.get(notification.transaction.originalTransactionId)
      if (userId !== undefined) return this.#users.get(userId)
    }
    const renewal = notification.renewal
    const original = renewal?.['originalTransactionId']
    if (typeof original === 'string') {
      const userId = this.#bindings.get(original)
      if (userId !== undefined) return this.#users.get(userId)
    }
    return undefined
  }

  /** Build the public shape for one user. */
  #public(user: UserRecord, deviceId: string | null, now: number): PublicUser {
    return publicUser(user, now, deviceId, this.#sessions)
  }

  /** Persist the account file. */
  async #saveAccounts(): Promise<void> {
    await writeJsonAtomic(this.#accountsPath, {
      version: 1,
      users: [...this.#users.values()],
      sessions: this.#sessions,
      appStoreBindings: [...this.#bindings].map(([originalTransactionId, userId]) => ({
        originalTransactionId,
        userId,
      })),
      processedAppStoreEvents: [...this.#processed],
    } satisfies AccountsFile)
  }

  /** Persist the invite file. */
  async #saveInvites(): Promise<void> {
    await writeJsonAtomic(this.#invitesPath, {
      version: 1,
      codes: [...this.#invites.values()],
    } satisfies InvitesFile)
  }

  /** Append one audit line. */
  async #audit(event: string, fields: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      await appendFile(
        this.#auditPath,
        `${JSON.stringify({ at: this.#now(), event, ...fields })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (error) {
      this.#log(`accounts: could not write audit log: ${(error as Error).message}`)
    }
  }
}

/** Hash one session token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Validate a username. */
export function validateUsername(value: string): string {
  const username = value.trim()
  const length = Array.from(username).length
  if (length < 2 || length > 32) throw new AccountError('INVALID_INPUT', 'usernames are 2-32 characters', 400)
  if (/[\s@\u0000-\u001f\u007f]/u.test(username)) {
    throw new AccountError('INVALID_INPUT', 'usernames cannot contain whitespace, @, or control characters', 400)
  }
  return username
}

/** Validate an email. */
export function validateEmail(value: string): string {
  const email = value.trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountError('INVALID_INPUT', 'that email address is not valid', 400)
  }
  return email
}

/** Validate a password's length. */
export function validatePassword(value: string): void {
  const length = value.length
  if (length < 8 || length > 128) {
    throw new AccountError('INVALID_INPUT', 'passwords are 8-128 characters', 400)
  }
}

/** Validate a password's length without requiring registration strength rules
 * beyond the stored limit; login must accept exactly what registration stored. */
export function validatePasswordShape(value: string): void {
  if (value.length === 0 || value.length > 128) {
    throw new AccountError('INVALID_INPUT', 'password is required', 400)
  }
}

/** Validate a device descriptor. */
export function validateDevice(device: DeviceInput): DeviceInput {
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(device.id)) {
    throw new AccountError('INVALID_INPUT', 'device.id is not an installation id', 400)
  }
  return {
    id: device.id,
    name: clean(device.name, 80) || 'iPhone',
    model: clean(device.model, 80) || 'unknown',
    platform: clean(device.platform, 16) || 'ios',
    appVersion: clean(device.appVersion, 40) || 'unknown',
  }
}

/** Normalize an invite code. */
export function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase()
}

/** Generate a readable invite code. */
export function generateInviteCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = randomBytes(12)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return `MZ-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`
}

/** Build a base username for an Apple account. */
export function deriveUsername(fullName: string | undefined, email: string | null, sub: string): string {
  const name = fullName?.trim()
  if (name !== undefined && name !== '') {
    const cleaned = name
      .replace(/[@\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, '')
      .slice(0, 24)
    if (cleaned.length >= 2) return cleaned
  }
  if (email !== null) {
    const local = email.split('@')[0]?.replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 24) ?? ''
    if (local.length >= 2) return local
  }
  return `apple-${sub.slice(0, 8)}`
}

/** Trim and cap a user-supplied label. */
function clean(value: string, max: number): string {
  return value.trim().slice(0, max)
}

/** Re-export the effective plan helper for the admin UI. */
export { effectivePaidUntil, generatedAvatar }
