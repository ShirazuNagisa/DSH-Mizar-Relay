import { describe, expect, it } from 'vitest'
import { aggregateActivity, type ActivityHostSnapshot } from '../src/activity-aggregate.js'

const now = 1_800_000_000_000

function host(
  hostId: string,
  rows: ActivityHostSnapshot['rows'],
  approvals: ActivityHostSnapshot['approvals'] = [],
  hostName = hostId,
): ActivityHostSnapshot {
  return { hostId, hostName, rows, approvals }
}

describe('aggregateActivity', () => {
  it('keeps same session ids from different hosts as separate rows', () => {
    const state = aggregateActivity([
      host('host-a', [{ sessionId: 'same-id', title: 'A', runningSince: now - 4_000 }]),
      host('host-b', [{ sessionId: 'same-id', title: 'B', runningSince: now - 8_000 }]),
    ], now, 7)

    expect(state.rows.map(({ id, hostId }) => [id, hostId])).toEqual([
      ['same-id', 'host-b'],
      ['same-id', 'host-a'],
    ])
    expect(state.totalCount).toBe(2)
    expect(state.deviceCount).toBe(2)
    expect(state.revision).toBe(7)
  })

  it('retains the other host when one host has ended its session', () => {
    const state = aggregateActivity([
      host('host-a', []),
      host('host-b', [{ sessionId: 'session-b', title: 'Still running', runningSince: now - 1_000 }]),
    ], now, 1)

    expect(state.rows.map(({ hostId, id }) => [hostId, id])).toEqual([['host-b', 'session-b']])
    expect(state.totalCount).toBe(1)
  })

  it('counts every distinct session while showing at most four parallel rows', () => {
    const state = aggregateActivity([
      host('host-a', [0, 1, 2].map((index) => ({
        sessionId: `a-${index}`,
        title: `A${index}`,
        runningSince: now - (index + 1) * 1_000,
      }))),
      host('host-b', [{ sessionId: 'b-0', title: 'B0', runningSince: now - 4_000 }]),
    ], now, 1)

    expect(state.totalCount).toBe(4)
    expect(state.rows).toHaveLength(4)
    expect(state.rows.map(({ id }) => id)).toEqual(['b-0', 'a-2', 'a-1', 'a-0'])
  })

  it('orders waiting rows before running rows and derives the longest timer from running only', () => {
    const state = aggregateActivity([
      host('host-a', [
        { sessionId: 'new-running', title: 'Running', runningSince: now - 20_000, status: 'running' },
        { sessionId: 'answer', title: 'Answer', runningSince: now - 90_000, status: 'waitingAnswer' },
        { sessionId: 'approval', title: 'Approval', runningSince: now - 120_000, status: 'waitingApproval' },
        { sessionId: 'old-running', title: 'Older running', runningSince: now - 30_000, status: 'running' },
      ]),
    ], now, 1)

    expect(state.rows.map(({ id }) => id)).toEqual(['approval', 'answer', 'old-running', 'new-running'])
    expect(state.longestRunningSince).toBe((now - 30_000) / 1000 - 978_307_200)
    expect(state.rows[0]?.countingSince).toBe((now - 120_000) / 1000 - 978_307_200)
  })

  it('orders equal waiting statuses by waiting age while keeping the turn timer independent', () => {
    const state = aggregateActivity([
      host('host-a', [
        {
          sessionId: 'waited-later', title: 'Later wait', runningSince: now - 300_000,
          waitingSince: now - 10_000, status: 'waitingAnswer',
        },
        {
          sessionId: 'waited-earlier', title: 'Earlier wait', runningSince: now - 30_000,
          waitingSince: now - 60_000, status: 'waitingAnswer',
        },
      ]),
    ], now, 1)

    expect(state.rows.map(({ id }) => id)).toEqual(['waited-earlier', 'waited-later'])
    expect(state.rows[0]?.countingSince).toBe((now - 30_000) / 1000 - 978_307_200)
    expect(state.rows[0]?.waitingSince).toBe((now - 60_000) / 1000 - 978_307_200)
  })

  it('uses the earliest matching approval time when a legacy row has no waiting age', () => {
    const state = aggregateActivity([
      host('host-a', [{
        sessionId: 'session', title: 'Task', runningSince: now - 180_000, status: 'waitingApproval',
      }], [
        { requestId: 'newer', sessionId: 'session', tool: 'Bash', detail: 'Second', requestedAt: now - 20_000 },
        { requestId: 'older', sessionId: 'session', tool: 'Bash', detail: 'First', requestedAt: now - 70_000 },
      ]),
    ], now, 1)

    expect(state.rows[0]?.countingSince).toBe((now - 180_000) / 1000 - 978_307_200)
    expect(state.rows[0]?.waitingSince).toBe((now - 70_000) / 1000 - 978_307_200)
  })

  it('keeps legacy snapshots without waiting age valid and leaves the field absent when unknown', () => {
    const state = aggregateActivity([
      host('host-a', [
        { sessionId: 'legacy-first', title: 'First', runningSince: now - 5_000, status: 'waitingAnswer' },
        { sessionId: 'legacy-second', title: 'Second', runningSince: now - 50_000, status: 'waitingAnswer' },
      ]),
    ], now, 1)

    expect(state.rows.map(({ id }) => id)).toEqual(['legacy-first', 'legacy-second'])
    expect(state.rows[0]?.countingSince).toBe((now - 5_000) / 1000 - 978_307_200)
    expect(state.rows[0]?.waitingSince).toBeUndefined()
    expect(state.rows[1]?.waitingSince).toBeUndefined()
  })

  it('adds a safe waitingApproval row for an approval-only session and counts sessions once', () => {
    const state = aggregateActivity([
      host('host-a', [], [
        { requestId: 'request-1', sessionId: 'opaque-session', tool: 'shell', detail: 'Need approval' },
        { requestId: 'request-2', sessionId: 'opaque-session', tool: 'write', detail: 'Also pending' },
      ], 'Workstation'),
    ], now, 3)

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      id: 'opaque-session',
      title: '等待审批',
      status: 'waitingApproval',
      hostId: 'host-a',
      hostName: 'Workstation',
    })
    expect(state.rows[0]?.title).not.toContain('opaque-session')
    expect(state.totalCount).toBe(1)
    expect(state.approvalCount).toBe(2)
    expect(state.approvals).toHaveLength(2)
  })

  it('enforces the UTF-8 budget without cutting identities or invalidating Unicode', () => {
    const hostName = '设备名称很长🔭'.repeat(250)
    const title = '会话标题🧭'.repeat(250)
    const detail = '审批详情与更多说明🧪'.repeat(250)
    const state = aggregateActivity([
      host('host-安全-id', [{
        sessionId: 'session-保持完整', title, runningSince: now, waitingSince: now - 1_000,
        status: 'waitingApproval',
      }], [{
        requestId: 'request-完整-id',
        sessionId: 'session-保持完整',
        tool: '工具🔧'.repeat(250),
        detail,
        requestedAt: now - 1_000,
      }], hostName),
    ], now, 9)
    const json = JSON.stringify(state)

    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(3_500)
    expect(() => JSON.parse(json)).not.toThrow()
    expect(state.rows[0]?.id).toBe('session-保持完整')
    expect(state.rows[0]?.hostId).toBe('host-安全-id')
    expect(state.rows[0]?.waitingSince).toBe((now - 1_000) / 1000 - 978_307_200)
    expect(state.approvals[0]).toMatchObject({
      requestId: 'request-完整-id',
      sessionId: 'session-保持完整',
      hostId: 'host-安全-id',
      requiresDetail: true,
    })
    expect([...json].some((character) => character === '\uFFFD')).toBe(false)
  })

  it('limits displayed approvals to four but keeps the full count', () => {
    const state = aggregateActivity([
      host('host-a', [], Array.from({ length: 5 }, (_, index) => ({
        requestId: `request-${index}`,
        sessionId: `session-${index}`,
        tool: 'tool',
        detail: 'detail',
        requestedAt: now - (5 - index) * 1_000,
      }))),
    ], now, 1)

    expect(state.approvalCount).toBe(5)
    expect(state.approvals).toHaveLength(4)
    expect(state.approvals.map(({ requestId }) => requestId)).toEqual([
      'request-0',
      'request-1',
      'request-2',
      'request-3',
    ])
  })

  it('returns a stable empty state for no hosts', () => {
    expect(aggregateActivity([], now, 0)).toEqual({
      rows: [],
      approvals: [],
      totalCount: 0,
      deviceCount: 0,
      approvalCount: 0,
      revision: 0,
    })
  })
})
