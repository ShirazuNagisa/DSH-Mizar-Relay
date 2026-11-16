import { describe, expect, it } from 'vitest'
import { PushRegistry, readActivity, readDevice } from '../src/push.js'
import { aggregateActivity, type ActivityHostSnapshot } from '../src/activity-aggregate.js'

function device(id: string, observedAt: number, activity: string | null) {
  return readDevice({ deviceId: id, token: 'aaaa', environment: 'sandbox', liveActivityVersion: 2,
    liveActivityTokenObservedAt: observedAt, liveActivityToken: activity, liveActivityStartToken: 'dddd' })!
}
function snapshot(hostId: string, allowedDeviceIds: string[]): ActivityHostSnapshot {
  return {
    hostId,
    hostName: hostId,
    rows: [{ sessionId: 'same', title: 'Task', runningSince: 1_800_000_000_000, allowedDeviceIds }],
    approvals: [{ requestId: 'approval-1', sessionId: 'same', tool: 'Shell', detail: 'Confirm', allowedDeviceIds }],
  }
}
describe('multi-host activity registration boundaries', () => {
  it('filters each room using its own registered device identity', () => {
    const registry = new PushRegistry()
    registry.register('a', device('phone-a', 100, 'bbbb'))
    registry.register('b', device('phone-b', 100, 'bbbb'))
    registry.setActivitySnapshot('a', snapshot('host-a', ['phone-b']), 1, 100)
    registry.setActivitySnapshot('b', snapshot('host-b', ['phone-b']), 1, 100)
    registry.setActivitySnapshot('not-paired', snapshot('host-c', ['phone-b']), 1, 100)
    const state = aggregateActivity(registry.activitySnapshotsForDevice('aaaa', 'sandbox'), 1_800_000_100_000, 1)
    expect(state.rows.map(row => row.hostId)).toEqual(['host-b'])
  })
  it('does not let a cached registration resurrect an older card or undo a newer clear', () => {
    const registry = new PushRegistry()
    registry.register('a', device('phone-a', 100, 'bbbb'))
    registry.register('b', device('phone-b', 200, 'cccc'))
    registry.register('a', device('phone-a', 100, 'bbbb'))
    expect(registry.devices('a')[0]?.liveActivityToken).toBe('cccc')
    registry.register('b', device('phone-b', 300, null))
    registry.register('a', device('phone-a', 100, 'bbbb'))
    expect(registry.devices('a')[0]?.liveActivityToken).toBeNull()
  })
  it('does not let a late 410 retire a newer card', () => {
    const registry = new PushRegistry()
    registry.register('a', device('phone-a', 100, 'bbbb'))
    registry.register('b', device('phone-b', 200, 'cccc'))
    registry.retireLiveActivityToken('aaaa', 'sandbox', 'bbbb')
    expect(registry.devices('b')[0]?.liveActivityToken).toBe('cccc')
    registry.register('a', device('phone-a', 100, 'bbbb'))
    expect(registry.devices('a')[0]?.liveActivityToken).toBe('cccc')
  })
  it('accepts an authoritative empty v2 snapshot without requiring a revision', () => {
    expect(readActivity({ phase: 'start', hostId: 'host', hostName: 'Mac', snapshotVersion: 2, sentAt: 100, rows: [], approvals: [] })).not.toBeNull()
    expect(readActivity({ phase: 'start', rows: [], approvals: [] })).toBeNull()
  })

  it('marks only the disconnected room offline and keeps its cached approval until a fresh snapshot', () => {
    const registry = new PushRegistry()
    registry.register('a', device('phone-a', 100, 'bbbb'))
    registry.register('b', device('phone-b', 100, 'bbbb'))
    registry.setActivitySnapshot('a', snapshot('host-a', ['phone-a']), 8, 100)
    registry.setActivitySnapshot('b', snapshot('host-b', ['phone-b']), 8, 100)

    registry.setRoomAvailable('a', false)
    expect(registry.needsActivitySnapshot('a')).toBe(true)
    expect(registry.needsActivitySnapshot('b')).toBe(false)
    const [offlineA, onlineB] = registry.activitySnapshotsForDevice('aaaa', 'sandbox')
    expect(offlineA?.rows[0]?.status).toBe('offline')
    expect(offlineA?.approvals).toHaveLength(1)
    expect(onlineB?.rows[0]?.status).toBeUndefined()

    // A newly accepted tunnel is still unavailable to the activity card until
    // that connection publishes its first fresh snapshot.
    registry.setRoomAvailable('a', false)
    expect(registry.needsActivitySnapshot('a')).toBe(true)
    expect(registry.activitySnapshotsForDevice('aaaa', 'sandbox')[0]?.rows[0]?.status).toBe('offline')

    expect(registry.setActivitySnapshot('a', snapshot('host-a', ['phone-a']), 0, 101)).toBe(true)
    expect(registry.needsActivitySnapshot('a')).toBe(false)
    const restored = registry.activitySnapshotsForDevice('aaaa', 'sandbox')[0]
    expect(restored?.rows[0]?.status).toBeUndefined()
    expect(restored?.approvals).toHaveLength(1)
  })

  it('allows a new sentAt to reset revision and requires a higher revision for the same sentAt', () => {
    const registry = new PushRegistry()
    const initial = snapshot('host-a', ['phone-a'])
    expect(registry.setActivitySnapshot('a', initial, 42, 100)).toBe(true)
    expect(registry.setActivitySnapshot('a', snapshot('host-a', []), 0, 101)).toBe(true)
    expect(registry.setActivitySnapshot('a', initial, 99, 100)).toBe(false)
    expect(registry.setActivitySnapshot('a', initial, undefined, 101)).toBe(false)
    expect(registry.setActivitySnapshot('a', initial, 0, 101)).toBe(false)
    expect(registry.setActivitySnapshot('a', initial, 1, 101)).toBe(true)

    expect(registry.setActivitySnapshot('b', initial, undefined, 200)).toBe(true)
    expect(registry.setActivitySnapshot('b', initial, 1, 200)).toBe(false)
    expect(registry.setActivitySnapshot('b', initial, undefined, 201)).toBe(true)
  })
})
