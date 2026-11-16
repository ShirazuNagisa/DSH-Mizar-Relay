const SWIFT_REFERENCE_EPOCH = 978_307_200
const MAX_CONTENT_BYTES = 3_500

export interface ActivityHostSnapshot {
  readonly hostId: string
  readonly hostName: string
  readonly rows: readonly {
    readonly sessionId: string
    readonly title: string
    readonly runningSince: number
    /** Epoch milliseconds since this row has waited; absent on legacy snapshots. */
    readonly waitingSince?: number
    readonly status?: 'running' | 'waitingApproval' | 'waitingAnswer' | 'offline'
    readonly allowedDeviceIds?: readonly string[]
  }[]
  readonly approvals: readonly {
    readonly requestId: string
    readonly sessionId: string
    readonly tool: string
    readonly detail: string
    readonly requestedAt?: number
    readonly requiresDetail?: boolean
    readonly allowedDeviceIds?: readonly string[]
  }[]
}

export interface AggregatedActivityContentState {
  readonly rows: readonly {
    readonly id: string
    readonly prompt: ''
    readonly title: string
    readonly elapsed: number
    readonly countingSince: number
    /** Swift reference-epoch seconds since waiting began, when known. */
    readonly waitingSince?: number
    readonly hostId: string
    readonly hostName: string
    readonly status: 'running' | 'waitingApproval' | 'waitingAnswer' | 'offline'
  }[]
  readonly approvals: readonly {
    readonly requestId: string
    readonly sessionId: string
    readonly tool: string
    readonly detail: string
    readonly hostId: string
    readonly hostName: string
    readonly requestedAt?: number
    readonly requiresDetail: boolean
  }[]
  readonly totalCount: number
  readonly deviceCount: number
  readonly approvalCount: number
  readonly longestRunningSince?: number
  readonly revision: number
}

interface Session {
  hostId: string
  hostName: string
  sessionId: string
  title: string
  runningSince: number
  waitingSince?: number
  status: 'running' | 'waitingApproval' | 'waitingAnswer' | 'offline'
  order: number
}

interface PendingApproval {
  hostId: string
  hostName: string
  requestId: string
  sessionId: string
  tool: string
  detail: string
  requestedAt?: number
  order: number
  requiresDetail: boolean
}

function sessionKey(hostId: string, sessionId: string): string {
  return JSON.stringify([hostId, sessionId])
}

function approvalKey(hostId: string, requestId: string): string {
  return JSON.stringify([hostId, requestId])
}

function statusRank(status: Session['status']): number {
  switch (status) {
    case 'waitingApproval':
      return 0
    case 'waitingAnswer':
      return 1
    case 'running':
      return 2
    case 'offline':
      return 3
  }
}

function earliestApprovalRequest(
  session: Session,
  approvals: readonly PendingApproval[],
): number | undefined {
  const requestedAt = approvals
    .filter((approval) => approval.hostId === session.hostId && approval.sessionId === session.sessionId)
    .map((approval) => approval.requestedAt)
    .filter((value): value is number => value !== undefined)
  return requestedAt.length === 0 ? undefined : Math.min(...requestedAt)
}

function waitingTime(session: Session, approvals: readonly PendingApproval[]): number | undefined {
  return session.waitingSince ??
    (session.status === 'waitingApproval' ? earliestApprovalRequest(session, approvals) : undefined)
}

function prefixByCodePoint(value: string, count: number): string {
  return Array.from(value).slice(0, count).join('')
}

function serializedBytes(state: AggregatedActivityContentState): number {
  return Buffer.byteLength(JSON.stringify(state), 'utf8')
}

/** Combine the authorized host snapshots into a size-bounded Live Activity state. */
export function aggregateActivity(
  snapshots: readonly ActivityHostSnapshot[],
  now: number,
  revision: number,
): AggregatedActivityContentState {
  const sessions = new Map<string, Session>()
  const approvals = new Map<string, PendingApproval>()
  let order = 0

  for (const snapshot of snapshots) {
    for (const row of snapshot.rows) {
      const key = sessionKey(snapshot.hostId, row.sessionId)
      const candidate: Session = {
        hostId: snapshot.hostId,
        hostName: snapshot.hostName,
        sessionId: row.sessionId,
        title: row.title,
        runningSince: row.runningSince,
        ...(row.waitingSince === undefined ? {} : { waitingSince: row.waitingSince }),
        status: row.status ?? 'running',
        order: order++,
      }
      const current = sessions.get(key)
      if (current === undefined || statusRank(candidate.status) < statusRank(current.status)) {
        sessions.set(key, candidate)
      } else if (current.status === candidate.status && candidate.waitingSince !== undefined) {
        current.waitingSince = current.waitingSince === undefined
          ? candidate.waitingSince
          : Math.min(current.waitingSince, candidate.waitingSince)
      }
    }
  }

  for (const snapshot of snapshots) {
    for (const approval of snapshot.approvals) {
      const key = approvalKey(snapshot.hostId, approval.requestId)
      if (!approvals.has(key)) {
        approvals.set(key, {
          hostId: snapshot.hostId,
          hostName: snapshot.hostName,
          ...approval,
          order: order++,
          requiresDetail: approval.requiresDetail === true || approval.tool.trim() === "" || approval.detail.trim() === "",
        })
      }
      const rowKey = sessionKey(snapshot.hostId, approval.sessionId)
      if (!sessions.has(rowKey)) {
        sessions.set(rowKey, {
          hostId: snapshot.hostId,
          hostName: snapshot.hostName,
          sessionId: approval.sessionId,
          title: '等待审批',
          runningSince: now,
          status: 'waitingApproval',
          order: order++,
        })
      } else {
        const session = sessions.get(rowKey)
        if (session !== undefined && session.status !== 'offline') {
          if (session.status !== 'waitingApproval') session.waitingSince = undefined
          session.status = 'waitingApproval'
        }
      }
    }
  }

  const allSessions = [...sessions.values()]
  const allApprovals = [...approvals.values()]
  const sortedSessions = allSessions.sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status)
    if (rank !== 0) return rank
    if (a.status === 'waitingApproval' || a.status === 'waitingAnswer') {
      const aWaitingSince = waitingTime(a, allApprovals)
      const bWaitingSince = waitingTime(b, allApprovals)
      if (aWaitingSince !== undefined && bWaitingSince !== undefined && aWaitingSince !== bWaitingSince) {
        return aWaitingSince - bWaitingSince
      }
      if (aWaitingSince !== undefined && bWaitingSince === undefined) return -1
      if (aWaitingSince === undefined && bWaitingSince !== undefined) return 1
    } else if (a.runningSince !== b.runningSince) {
      return a.runningSince - b.runningSince
    }
    return a.order - b.order
  })
  const sortedApprovals = allApprovals.sort((a, b) => {
    if (a.requestedAt !== undefined && b.requestedAt !== undefined && a.requestedAt !== b.requestedAt) {
      return a.requestedAt - b.requestedAt
    }
    if (a.requestedAt !== undefined && b.requestedAt === undefined) return -1
    if (a.requestedAt === undefined && b.requestedAt !== undefined) return 1
    return a.order - b.order
  })

  const state: {
    rows: AggregatedActivityContentState['rows'][number][]
    approvals: (AggregatedActivityContentState['approvals'][number] & { requestedAt?: number })[]
    totalCount: number
    deviceCount: number
    approvalCount: number
    longestRunningSince?: number
    revision: number
  } = {
    rows: sortedSessions.slice(0, 4).map((session) => ({
      id: session.sessionId,
      prompt: '',
      title: session.title,
      elapsed: Math.max(0, (now - session.runningSince) / 1000),
      countingSince: session.runningSince / 1000 - SWIFT_REFERENCE_EPOCH,
      ...(session.waitingSince !== undefined || session.status === 'waitingApproval'
        ? (() => {
            const waitingSince = session.waitingSince ?? earliestApprovalRequest(session, allApprovals)
            return waitingSince === undefined
              ? {}
              : { waitingSince: waitingSince / 1000 - SWIFT_REFERENCE_EPOCH }
          })()
        : {}),
      hostId: session.hostId,
      hostName: session.hostName,
      status: session.status,
    })),
    approvals: sortedApprovals.slice(0, 4).map((approval) => ({
      requestId: approval.requestId,
      sessionId: approval.sessionId,
      tool: approval.tool,
      detail: approval.detail,
      hostId: approval.hostId,
      hostName: approval.hostName,
      ...(approval.requestedAt === undefined
        ? {}
        : { requestedAt: approval.requestedAt / 1000 - SWIFT_REFERENCE_EPOCH }),
      requiresDetail: approval.requiresDetail,
    })),
    totalCount: allSessions.length,
    deviceCount: new Set(allSessions.map((session) => session.hostId)).size,
    approvalCount: allApprovals.length,
    ...(allSessions.some((session) => session.status === 'running')
      ? {
          longestRunningSince:
            Math.min(...allSessions.filter((session) => session.status === 'running').map((session) => session.runningSince)) /
              1000 -
            SWIFT_REFERENCE_EPOCH,
        }
      : {}),
    revision,
  }

  while (serializedBytes(state) > MAX_CONTENT_BYTES) {
    const displays = [
      ...state.rows.flatMap((row, index) => [
        { kind: 'row' as const, index, field: 'title' as const, value: row.title },
        { kind: 'row' as const, index, field: 'hostName' as const, value: row.hostName },
      ]),
      ...state.approvals.flatMap((approval, index) => [
        { kind: 'approval' as const, index, field: 'tool' as const, value: approval.tool },
        { kind: 'approval' as const, index, field: 'detail' as const, value: approval.detail },
        { kind: 'approval' as const, index, field: 'hostName' as const, value: approval.hostName },
      ]),
    ].sort((a, b) => Buffer.byteLength(b.value, 'utf8') - Buffer.byteLength(a.value, 'utf8'))

    const display = displays.find(({ value }) => value.length > 0)
    if (display !== undefined) {
      const prefix = prefixByCodePoint(display.value, Math.floor(Array.from(display.value).length / 2))
      const shortened = prefix === "" ? "" : prefix.replace(/…$/, "") + "…"
      if (display.kind === 'row') {
        const row = state.rows[display.index]
        if (row !== undefined) state.rows[display.index] = { ...row, [display.field]: shortened }
      } else {
        const approval = state.approvals[display.index]
        if (approval !== undefined) {
          state.approvals[display.index] = {
            ...approval,
            [display.field]: shortened,
            ...((display.field === 'detail' || display.field === 'tool') ? { requiresDetail: true } : {}),
          }
        }
      }
      continue
    }

    if (state.approvals.length > 0) {
      state.approvals.pop()
    } else if (state.rows.length > 0) {
      state.rows.pop()
    } else {
      break
    }
  }

  return state
}
