// ============================================================================
// 关键验收：两个 API 实例（独立进程内连接池、真实 HTTP、真实 PostgreSQL）中
// 「撤最后一锁」与「复位」交错时，数据库行锁 + 单调修订号必须防住失锁更新。
//
// 验收口径：
//   - 复位最多成功一次（一旦 energized 不可逆转）
//   - 败方（409）所见阻断项或终态与数据库真值一致
//   - 任何交错顺序下不会出现"还有锁却已送电"
// ============================================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  PORT_A,
  PORT_B,
  startTwoInstances,
  stopTwoInstances,
  resetData,
  clientFor,
  CREDS,
  createTicketAsCoord,
  dbSnapshot,
  HttpError,
} from './harness.js'
import type { Snapshot } from '../src/shared/types.js'
import { pool } from '../src/server/db.js'

beforeAll(startTwoInstances)
afterAll(stopTwoInstances)
beforeEach(resetData)

interface RaceResult {
  name: string
  ok: boolean
  status?: number
  code?: string
  snapshot?: Snapshot
  blockers?: string[]
}

async function settled(p: Promise<any>, name: string): Promise<RaceResult> {
  try {
    const v = await p
    return { name, ok: true, snapshot: v.snapshot as Snapshot }
  } catch (e) {
    const err = e as HttpError
    return {
      name,
      ok: false,
      status: err.status,
      code: err.body?.error?.code,
      snapshot: err.body?.error?.snapshot,
      blockers: err.body?.error?.blockers,
    }
  }
}

/** 造一张：全部点已确认、zhang 挂着唯一一把锁、revision=N 的票 */
async function setupReadyWithOneLock(pointCount = 2): Promise<{
  ticketId: number
  revision: number
}> {
  const s = await createTicketAsCoord(PORT_A, {
    device: `race-${Math.random()}`,
    points: Array.from({ length: pointCount }, (_, i) => `点${i + 1}`),
    personnel: ['zhang', 'li'],
  })
  const zhang = await clientFor(PORT_A, CREDS.zhang)
  let rev = s.ticket.revision
  for (const p of s.points) {
    const r = await zhang.post<{ snapshot: Snapshot }>(
      `/api/tickets/${s.ticket.id}/confirm`,
      { pointId: p.id, revision: rev },
    )
    rev = r.snapshot.ticket.revision
  }
  const locked = await zhang.post<{ snapshot: Snapshot }>(
    `/api/tickets/${s.ticket.id}/locks`,
    { revision: rev },
  )
  return {
    ticketId: s.ticket.id,
    revision: locked.snapshot.ticket.revision,
  }
}

async function assertLoserAgreesWithDb(
  loser: RaceResult,
  ticketId: number,
) {
  const db = await dbSnapshot(ticketId)
  expect(loser.ok).toBe(false)
  expect(loser.status).toBe(409)
  expect(loser.snapshot).toBeTruthy()

  // 败方所见快照与数据库真值一致
  expect(loser.snapshot!.ticket.revision).toBe(db.revision)
  expect(loser.snapshot!.ticket.status).toBe(db.status)
  expect(loser.snapshot!.locks).toHaveLength(db.locks)

  if (db.status === 'energized') {
    // 败方所见终态
    expect(loser.snapshot!.blockers).toEqual(['terminal'])
    expect(loser.blockers ?? loser.snapshot!.blockers).toContain('terminal')
  } else {
    // 仍在检修 → 败方必须看到真实阻断项（有锁/有点未确认），不能误判可送电
    const seenBlockers = loser.blockers ?? loser.snapshot!.blockers
    expect(seenBlockers.length).toBeGreaterThan(0)
    if (db.locks > 0) expect(seenBlockers).toContain(`locks:${db.locks}`)
    if (db.unconfirmed > 0)
      expect(seenBlockers).toContain(`points:${db.unconfirmed}`)
    // 按败方快照自己的裁决：也绝不能是可送电状态
    const resetReadyByLoser =
      loser.snapshot!.ticket.status === 'maintenance' &&
      loser.snapshot!.locks.length === 0 &&
      loser.snapshot!.points.every((p) => p.confirmed_by != null)
    expect(resetReadyByLoser).toBe(false)
  }
}

describe('挂最后一锁 × 复位 双实例交错', () => {
  /** 造一张：全部点已确认、当前无锁、revision=N（可直接送电）的票 */
  async function setupReadyNoLock(pointCount = 1): Promise<{
    ticketId: number
    revision: number
  }> {
    const s = await createTicketAsCoord(PORT_A, {
      device: `race-lock-${Math.random()}`,
      points: Array.from({ length: pointCount }, (_, i) => `点${i + 1}`),
      personnel: ['zhang', 'li'],
    })
    const zhang = await clientFor(PORT_A, CREDS.zhang)
    let rev = s.ticket.revision
    for (const p of s.points) {
      const r = await zhang.post<{ snapshot: Snapshot }>(
        `/api/tickets/${s.ticket.id}/confirm`,
        { pointId: p.id, revision: rev },
      )
      rev = r.snapshot.ticket.revision
    }
    return { ticketId: s.ticket.id, revision: rev }
  }

  it('同 revision 并发挂锁与复位：复位成功则必无锁；挂锁成功则复位必败且看到 locks:1', async () => {
    for (let round = 1; round <= 10; round++) {
      const { ticketId, revision } = await setupReadyNoLock()

      const zhangA = await clientFor(PORT_A, CREDS.zhang) // 挂锁走实例 A
      const leadB = await clientFor(PORT_B, CREDS.lead) // 复位走实例 B

      const [place, reset] = await Promise.all([
        settled(
          zhangA.post(`/api/tickets/${ticketId}/locks`, { revision }),
          'place',
        ),
        settled(
          leadB.post(`/api/tickets/${ticketId}/reset`, { revision }),
          'reset',
        ),
      ])

      const db = await dbSnapshot(ticketId)

      // 绝不允许“已送电同时仍有个人锁”
      expect(db.status === 'energized' && db.locks > 0).toBe(false)

      if (reset.ok) {
        // 复位先到：终态、无锁；挂锁必败，且败方所见与库一致（terminal）
        expect(db.status).toBe('energized')
        expect(db.locks).toBe(0)
        expect(place.ok).toBe(false)
        await assertLoserAgreesWithDb(place, ticketId)
      } else {
        // 挂锁先到：库中检修态 + 1 把锁；复位必败，败方必须看到 locks:1，
        // 绝不会误判“可送电”
        expect(place.ok).toBe(true)
        expect(db.status).toBe('maintenance')
        expect(db.locks).toBe(1)
        expect(reset.status).toBe(409)
        expect(reset.code).toBe('CONFLICT')
        const seenBlockers = reset.blockers ?? reset.snapshot!.blockers
        expect(seenBlockers).toContain('locks:1')
        expect(reset.snapshot!.ticket.revision).toBe(db.revision)
        const resetReadyByLoser =
          reset.snapshot!.ticket.status === 'maintenance' &&
          reset.snapshot!.locks.length === 0 &&
          reset.snapshot!.points.every((p) => p.confirmed_by != null)
        expect(resetReadyByLoser).toBe(false)
      }
    }
  })
})

describe('撤最后一锁 × 复位 双实例交错', () => {
  // 重复多轮以提高交错命中率（FOR UPDATE 使两轮顺序都被覆盖）
  for (let round = 1; round <= 10; round++) {
    it(`第 ${round} 轮：同 revision 并发，恰有一方成功且败方与库一致`, async () => {
      const { ticketId, revision } = await setupReadyWithOneLock()

      const zhangA = await clientFor(PORT_A, CREDS.zhang) // 撤锁走实例 A
      const leadB = await clientFor(PORT_B, CREDS.lead) // 复位走实例 B

      // 两侧都基于页面所见同一旧修订号并发提交
      const [remove, reset] = await Promise.all([
        settled(
          zhangA.del(`/api/tickets/${ticketId}/locks`, { revision }),
          'remove',
        ),
        settled(
          leadB.post(`/api/tickets/${ticketId}/reset`, { revision }),
          'reset',
        ),
      ])

      const db = await dbSnapshot(ticketId)

      // 撤锁方：只要票当时还在检修，撤锁必成功；若复位先到终态则撤锁失败
      if (remove.ok) {
        expect(remove.name).toBe('remove')
      }

      // 核心断言 1：复位最多成功一次——且本轮不可能"复位成功同时锁还在"
      if (reset.ok) {
        expect(db.status).toBe('energized')
        expect(db.locks).toBe(0)
        // 复位成功 ⇒ 撤锁必然失败（它拿到的是终态之后的视图）
        expect(remove.ok).toBe(false)
        await assertLoserAgreesWithDb(remove, ticketId)
      } else {
        // 复位失败 ⇒ 撤锁成功，票仍在检修，败方必须看见"无锁可送?" —— 不，
        // 撤锁已提交所以库中无锁；败方失败的原因是修订号过期（remove 先提交），
        // 其快照显示 maintenance + 0 锁 + 已全部确认。
        expect(remove.ok).toBe(true)
        expect(db.status).toBe('maintenance')
        expect(db.locks).toBe(0)
        expect(reset.snapshot!.ticket.revision).toBe(db.revision)
        expect(reset.snapshot!.ticket.status).toBe('maintenance')
        expect(reset.snapshot!.locks).toHaveLength(0)
        expect(reset.code).toBe('CONFLICT') // 旧页面：revision 过期
        // 败方用"最新快照 + 新修订号"重试复位应当成功（且仅一次）
        const leadB2 = await clientFor(PORT_B, CREDS.lead)
        const retry = await leadB2.post<{ snapshot: Snapshot }>(
          `/api/tickets/${ticketId}/reset`,
          { revision: db.revision },
        )
        expect(retry.snapshot.ticket.status).toBe('energized')
      }

      // 核心断言 2：最终态必须为 energized（败方刷新后可以完成送电），
      // 且数据库中绝不可能残留锁
      const dbFinal = await dbSnapshot(ticketId)
      expect(dbFinal.status).toBe('energized')
      expect(dbFinal.locks).toBe(0)
    })
  }

  it('票已送电后，携带最新修订号再次复位仍被拒绝，revision/updated_at 不被改写', async () => {
    const { ticketId, revision } = await setupReadyWithOneLock(1)
    const zhangA = await clientFor(PORT_A, CREDS.zhang)
    await zhangA.del(`/api/tickets/${ticketId}/locks`, { revision })
    const dbAfterRemove = await dbSnapshot(ticketId)

    const lead = await clientFor(PORT_B, CREDS.lead)
    const first = await lead.post<{ snapshot: Snapshot }>(
      `/api/tickets/${ticketId}/reset`,
      { revision: dbAfterRemove.revision },
    )
    expect(first.snapshot.ticket.status).toBe('energized')
    const energizedRev = first.snapshot.ticket.revision

    // 浏览器/重试程序拿着【最新】修订号再次复位：必须 409 terminal
    const again = await settled(
      lead.post(`/api/tickets/${ticketId}/reset`, { revision: energizedRev }),
      'reset-again',
    )
    expect(again.ok).toBe(false)
    expect(again.status).toBe(409)
    expect(again.code).toBe('CONFLICT')
    expect(again.blockers ?? again.snapshot!.blockers).toContain('terminal')

    const db = await dbSnapshot(ticketId)
    expect(db.status).toBe('energized')
    expect(db.revision).toBe(energizedRev) // 修订号未被反复改写

    // 同一票连续第三次复位同样被拒，且 updated_at 停留在首次送电时刻
    const third = await settled(
      lead.post(`/api/tickets/${ticketId}/reset`, { revision: energizedRev }),
      'reset-third',
    )
    expect(third.ok).toBe(false)
    expect(third.status).toBe(409)
    const db2 = await dbSnapshot(ticketId)
    expect(db2.revision).toBe(energizedRev)
    const { rows } = await pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM tickets WHERE id = $1',
      [ticketId],
    )
    expect(rows[0].updated_at.toISOString()).toBe(
      first.snapshot.ticket.updated_at,
    )
  })

  it('复位成功后再次复位（即便带最新 revision）仍被拒绝，且只成功一次', async () => {
    const { ticketId, revision } = await setupReadyWithOneLock(1)
    const zhangA = await clientFor(PORT_A, CREDS.zhang)
    const leadB = await clientFor(PORT_B, CREDS.lead)

    await zhangA.del(`/api/tickets/${ticketId}/locks`, { revision })
    const dbAfterRemove = await dbSnapshot(ticketId)

    // 多个送电负责人请求（模拟两个浏览器标签同时点）并发复位
    const leadA = await clientFor(PORT_A, CREDS.lead)
    const attempts = await Promise.all(
      [leadA, leadB, leadA, leadB].map((c, i) =>
        settled(
          c.post(`/api/tickets/${ticketId}/reset`, {
            revision: dbAfterRemove.revision,
          }),
          `reset-${i}`,
        ),
      ),
    )
    const successes = attempts.filter((a) => a.ok)
    const failures = attempts.filter((a) => !a.ok)
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(3)
    for (const f of failures) {
      expect(f.status).toBe(409)
      expect(f.snapshot!.ticket.status).toBe('energized')
      expect(f.snapshot!.blockers).toEqual(['terminal'])
    }
    const db = await dbSnapshot(ticketId)
    expect(db.status).toBe('energized')
    expect(db.revision).toBe(dbAfterRemove.revision + 1) // 仅自增一次
  })

  it('交错重放 20 轮：复位累计成功次数恰好等于票数（每票一次）', async () => {
    const N = 20
    const setups = await Promise.all(
      Array.from({ length: N }, () => setupReadyWithOneLock(1)),
    )
    let resetSuccesses = 0

    await Promise.all(
      setups.map(async ({ ticketId, revision }) => {
        const worker = await clientFor(
          Math.random() < 0.5 ? PORT_A : PORT_B,
          CREDS.zhang,
        )
        const lead = await clientFor(
          Math.random() < 0.5 ? PORT_A : PORT_B,
          CREDS.lead,
        )
        const [remove, reset] = await Promise.all([
          settled(
            worker.del(`/api/tickets/${ticketId}/locks`, { revision }),
            'remove',
          ),
          settled(
            lead.post(`/api/tickets/${ticketId}/reset`, { revision }),
            'reset',
          ),
        ])
        if (reset.ok) {
          resetSuccesses++
          await assertLoserAgreesWithDb(remove, ticketId)
        } else {
          // 复位败：拿最新 revision 再试一次（模拟负责人点页面上的刷新后送电）
          const db = await dbSnapshot(ticketId)
          if (db.status === 'maintenance') {
            const lead2 = await clientFor(PORT_A, CREDS.lead)
            const retry = await lead2.post<{ snapshot: Snapshot }>(
              `/api/tickets/${ticketId}/reset`,
              { revision: db.revision },
            )
            if (retry.snapshot.ticket.status === 'energized') resetSuccesses++
          }
        }
      }),
    )

    expect(resetSuccesses).toBe(N) // 每张票恰好送电一次
    const db = await (
      await clientFor(PORT_A, CREDS.lead)
    ).get<{ tickets: Snapshot[] }>('/api/tickets')
    expect(db.tickets).toHaveLength(N)
    expect(db.tickets.every((t) => t.ticket.status === 'energized')).toBe(true)
    expect(
      db.tickets.every((t) => t.blockers.join(',') === 'terminal'),
    ).toBe(true)
  })
})
