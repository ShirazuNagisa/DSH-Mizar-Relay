/**
 * Turn verified Apple events into entitlement changes.
 *
 * The rules worth stating once:
 *
 *   - A renewal only ever extends; an old transaction arriving late must not
 *     shorten a newer paid period.
 *   - A refund/revocation applies to the latest transaction. A refund for a
 *     period that has already been superseded must not cancel the newer one.
 *   - The App Store entitlement is independent of invite/admin grants, so a
 *     refund takes away only what Apple sold.
 *
 * @module dsh-mizar-relay/accounts/appstore/entitlements
 */
import type {
  AppStoreEntitlement,
  PublicAppStore,
  PublicUser,
  SessionRecord,
  UserRecord,
} from '../types.js'
import type { VerifiedNotification, VerifiedTransaction } from './verify.js'

/** The end of a user's paid period, or `null`. */
export function effectivePaidUntil(user: UserRecord): number | null {
  const granted = user.entitlements.grantedPaidUntil
  const appStore = user.entitlements.appStore?.paidUntil ?? null
  if (granted === null) return appStore
  if (appStore === null) return granted
  return Math.max(granted, appStore)
}

/** The sources that are currently active. */
export function paidSources(user: UserRecord, now: number): Array<'invite' | 'admin' | 'appstore'> {
  const out: Array<'invite' | 'admin' | 'appstore'> = []
  if ((user.entitlements.grantedPaidUntil ?? 0) > now) out.push('invite')
  if ((user.entitlements.appStore?.paidUntil ?? 0) > now) out.push('appstore')
  return out
}

/**
 * Apply one transaction to one user.
 *
 * @param user - the mutable stored user.
 * @param transaction - the verified transaction.
 * @param now - current epoch ms.
 * @returns whether anything changed.
 */
export function applyTransaction(user: UserRecord, transaction: VerifiedTransaction, now: number): boolean {
  const current = user.entitlements.appStore
  const revoked = transaction.revocationDate !== null && transaction.revocationDate <= now

  if (current === null || current.originalTransactionId !== transaction.originalTransactionId) {
    const paidUntil = revoked ? null : transaction.expiresDate
    user.entitlements.appStore = {
      paidUntil,
      originalTransactionId: transaction.originalTransactionId,
      productId: transaction.productId,
      environment: transaction.environment,
      autoRenew: current?.autoRenew ?? true,
      revokedAt: revoked ? now : null,
      lastVerifiedAt: now,
    }
    user.updatedAt = now
    return true
  }

  if (revoked) {
    // Only the latest period may be revoked. A refund for an already-expired
    // period is real but has no effect on a newer renewal.
    const latest = current.paidUntil ?? 0
    if (transaction.expiresDate >= latest) {
      current.paidUntil = null
      current.revokedAt = now
      current.lastVerifiedAt = now
      user.updatedAt = now
      return true
    }
    return false
  }

  const next = Math.max(current.paidUntil ?? 0, transaction.expiresDate)
  const changed =
    next !== current.paidUntil ||
    current.revokedAt !== null ||
    current.environment !== transaction.environment ||
    current.productId !== transaction.productId
  current.paidUntil = next === 0 ? null : next
  current.revokedAt = null
  current.productId = transaction.productId
  // `environment` and `originalTransactionId` are readonly in the stored shape
  // so a transaction cannot silently move a subscription between environments.
  current.lastVerifiedAt = now
  if (changed) user.updatedAt = now
  return changed
}

/**
 * Apply one App Store Server Notification V2.
 *
 * @param user - the mutable stored user.
 * @param notification - the verified notification.
 * @param now - current epoch ms.
 * @returns whether anything changed.
 */
export function applyNotification(
  user: UserRecord,
  notification: VerifiedNotification,
  now: number,
): boolean {
  let changed = false
  if (notification.transaction !== null) {
    changed = applyTransaction(user, notification.transaction, now)
  }
  const type = notification.notificationType
  const renewal = notification.renewal
  if (renewal !== null) {
    const status = renewal['autoRenewStatus']
    const autoRenew = status === 1 || status === '1' || status === true
    const appStore = user.entitlements.appStore
    if (appStore !== null && appStore.autoRenew !== autoRenew) {
      appStore.autoRenew = autoRenew
      user.updatedAt = now
      changed = true
    }
  }
  if (type === 'EXPIRED' || type === 'REFUND' || type === 'REVOKE' || type === 'GRACE_PERIOD_EXPIRED') {
    const appStore = user.entitlements.appStore
    // A revocation has to name the period it revokes. A notification without
    // transaction info (some renewal-only types) must not tear down a newer
    // entitlement that arrived from the client sync first.
    if (appStore !== null && notification.transaction !== null) {
      const transaction = notification.transaction
      const latest = appStore.paidUntil ?? 0
      if (transaction.expiresDate >= latest) {
        if (appStore.paidUntil !== null || appStore.revokedAt === null) {
          appStore.paidUntil = null
          appStore.revokedAt = now
          user.updatedAt = now
          changed = true
        }
      }
    }
  }
  return changed
}

/** The public shape of the App Store entitlement. */
export function publicAppStore(entitlement: AppStoreEntitlement | null): PublicAppStore | null {
  if (entitlement === null) return null
  return {
    paidUntil: entitlement.paidUntil,
    productId: entitlement.productId,
    environment: entitlement.environment,
    autoRenew: entitlement.autoRenew,
    revokedAt: entitlement.revokedAt,
  }
}

/**
 * Build the public user object.
 *
 * @param user - the stored user.
 * @param now - current epoch ms.
 * @param currentDeviceId - the device making the request, for `current`.
 * @param sessions - all sessions, used to mark active devices.
 * @returns the public object.
 */
export function publicUser(
  user: UserRecord,
  now: number,
  currentDeviceId: string | null,
  sessions?: readonly SessionRecord[],
): PublicUser {
  void sessions
  const until = effectivePaidUntil(user)
  const active = until !== null && until > now
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    plan: active ? 'paid' : 'free',
    paidUntil: until,
    paidSources: paidSources(user, now),
    grantedPaidUntil: user.entitlements.grantedPaidUntil,
    appStore: publicAppStore(user.entitlements.appStore),
    avatar: user.avatar,
    apple: user.appleSub !== null,
    github: user.githubId !== null,
    githubLogin: user.githubLogin,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    devices: user.devices.map((device) => ({
      id: device.id,
      name: device.name,
      model: device.model,
      platform: device.platform,
      loginAt: device.loginAt,
      lastSeenAt: device.lastSeenAt,
      current: currentDeviceId !== null && device.id === currentDeviceId,
    })),
  }
}
