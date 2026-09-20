import { useCallback, useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../shared/types.js'
import { api, ApiError } from './api.js'

export interface BoardNotice {
  kind: 'error' | 'conflict' | 'forbidden' | 'success' | 'info'
  text: string
}

/**
 * 牌板状态钩子。
 * - 任何写操作都携带当前页面所见 revision（snapshot.ticket.revision）。
 * - 409 CONFLICT：页面过期/并发失败，立即用错误体里的【最新快照】刷新牌板
 *   （修订号、锁数、确认状态、阻断项一并更新），并保留过期提示。这样后续
 *   操作提交的是最新修订号，不会拿着过期视图反复冲突或误判“可送电”；
 *   本次失败的变更本身不落库（未代签、未误复位）。
 * - 403 FORBIDDEN：提示越权，不改变牌板。
 */
export function useBoard(ticketId: number, onChanged?: (s: Snapshot) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<BoardNotice | null>(null)
  const [busy, setBusy] = useState(false)
  // 页面所见修订号；以最新成功加载的快照为准
  const seenRevision = useRef<number | null>(null)

  const applySnapshot = useCallback(
    (s: Snapshot) => {
      seenRevision.current = s.ticket.revision
      setSnapshot(s)
      onChanged?.(s)
    },
    [onChanged],
  )

  const reload = useCallback(async () => {
    try {
      const { snapshot } = await api.ticket(ticketId)
      applySnapshot(snapshot)
    } catch (err) {
      setNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : '加载牌板失败',
      })
    } finally {
      setLoading(false)
    }
  }, [ticketId, applySnapshot])

  useEffect(() => {
    setLoading(true)
    reload()
  }, [reload])

  /** 执行一个必须携带 revision 的变更；并发/越权/终态失败均不破坏当前牌板 */
  const mutate = useCallback(
    async (fn: (revision: number) => Promise<{ snapshot: Snapshot }>) => {
      if (seenRevision.current == null) return
      setBusy(true)
      setNotice(null)
      const rev = seenRevision.current
      try {
        const { snapshot } = await fn(rev)
        applySnapshot(snapshot)
        setNotice({ kind: 'success', text: '操作已提交' })
      } catch (err) {
        if (err instanceof ApiError && err.snapshot) {
          // CONFLICT 与 FORBIDDEN 都要用服务端快照刷新牌板：
          // 冲突意味着本地视图已被并发者改写，必须整体替换为最新快照，
          // 而不能只改提示文字、让牌板继续显示旧修订号/旧锁数/旧阻断项。
          applySnapshot(err.snapshot)
          if (err.code === 'CONFLICT') {
            const blockers = err.blockers ?? err.snapshot.blockers
            setNotice({
              kind: 'conflict',
              text:
                blockers.length > 0 && blockers.join('') !== ''
                  ? `页面已过期，已自动刷新到最新牌板（最新阻断项：${describeBlockers(blockers)}，最新修订号 ${err.snapshot.ticket.revision}）`
                  : `页面已过期，已自动刷新到最新牌板（最新修订号 ${err.snapshot.ticket.revision}）`,
            })
          } else {
            setNotice({ kind: 'forbidden', text: err.message })
          }
        } else if (err instanceof ApiError) {
          setNotice({
            kind: err.code === 'FORBIDDEN' ? 'forbidden' : 'error',
            text: err.message,
          })
        } else {
          setNotice({
            kind: 'error',
            text: err instanceof Error ? err.message : '操作失败',
          })
        }
      } finally {
        setBusy(false)
      }
    },
    [applySnapshot],
  )

  return { snapshot, loading, notice, busy, reload, mutate, setNotice }
}

export function describeBlockers(blockers: string[]): string {
  return blockers
    .map((b) => {
      if (b === 'terminal') return '票已送电(终态)'
      if (b.startsWith('points:')) return `未确认点 ${b.slice(7)} 个`
      if (b.startsWith('locks:')) return `个人锁 ${b.slice(6)} 把`
      return b
    })
    .join('、')
}
