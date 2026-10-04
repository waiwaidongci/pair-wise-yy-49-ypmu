import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem } from './seed'
import { seedState } from './seed'
import { opKey, type BatchPayload, type FieldOp, type Role } from './merge'

type CurriculumState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  locked: boolean
  draft: string
}

const saved = browser ? localStorage.getItem('curriculum-map-draft-v1') : null
const initial: CurriculumState = saved ? JSON.parse(saved) : structuredClone(seedState)

function createCurriculumStore() {
  const { subscribe, update, set } = writable<CurriculumState>({ ...initial, draft: initial.draft ?? 'C-308 对 GR-06 的案例证据不足，需补充评分记录。' })
  return {
    subscribe,
    set,
    update,
    moveNode(id: string, x: number, y: number) {
      update((state) => ({ ...state, nodes: state.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) }))
    },
    addMapping(source: string, target: string, relation: Mapping['relation'], weight: number) {
      update((state) => ({ ...state, mappings: [...state.mappings, { id: `M-${Date.now()}`, source, target, relation, weight }] }))
    },
    updateReview(id: string, status: ReviewItem['status'], comment: string) {
      update((state) => ({ ...state, reviewItems: state.reviewItems.map((item) => (item.id === id ? { ...item, status, comment } : item)) }))
    },
    saveDraft(draft: string) {
      update((state) => ({ ...state, draft }))
    },
    lock(revision: string) {
      update((state) => ({ ...state, revision, locked: true }))
    },
    /** 合并完成后以服务端实际并入版本为准，覆盖矩阵与课程地图导出随之重算 */
    applyServerState(server: { mappings: Mapping[]; reviewItems: ReviewItem[]; revision: string }) {
      update((state) => ({ ...state, mappings: server.mappings, reviewItems: server.reviewItems, revision: server.revision }))
    },
  }
}

export const curriculumStore = createCurriculumStore()

if (browser) {
  curriculumStore.subscribe((state) => localStorage.setItem('curriculum-map-draft-v1', JSON.stringify(state)))
}

function persisted<T>(key: string, initialValue: T) {
  const stored = browser ? localStorage.getItem(key) : null
  const store = writable<T>(stored ? JSON.parse(stored) : initialValue)
  if (browser) store.subscribe((value) => localStorage.setItem(key, JSON.stringify(value)))
  return store
}

export const roleStore = persisted<Role>('curriculum-role-v1', '课程负责人')
export const actorStore = persisted<string>('curriculum-actor-v1', '顾明')

export type FailedBatch = { payload: BatchPayload; error: string; at: string }

type OutboxState = {
  /** 暂存批次绑定的处理基线（修订版本） */
  baseRevision: string | null
  batchId: string | null
  staged: FieldOp[]
  /** 写入失败的批次：整批与基线保留，等待重试 */
  failed: FailedBatch[]
}

function newBatchId() {
  return `B-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function createReviewOutbox() {
  const empty: OutboxState = { baseRevision: null, batchId: null, staged: [], failed: [] }
  const stored = browser ? localStorage.getItem('curriculum-review-outbox-v1') : null
  const { subscribe, update } = writable<OutboxState>(stored ? { ...empty, ...JSON.parse(stored) } : empty)
  if (browser) subscribe((state) => localStorage.setItem('curriculum-review-outbox-v1', JSON.stringify(state)))
  return {
    subscribe,
    /** 没有暂存内容时，处理基线跟随系统当前版本 */
    bindBase(revision: string) {
      update((state) => (state.staged.length === 0 && state.baseRevision !== revision ? { ...state, baseRevision: revision } : state))
    },
    stage(op: FieldOp, baseRevision: string) {
      update((state) => {
        const key = opKey(op)
        return {
          ...state,
          baseRevision: state.baseRevision ?? baseRevision,
          batchId: state.batchId ?? newBatchId(),
          staged: [...state.staged.filter((entry) => opKey(entry) !== key), op],
        }
      })
    },
    unstage(index: number) {
      update((state) => {
        const staged = state.staged.filter((_, entryIndex) => entryIndex !== index)
        return { ...state, staged, ...(staged.length === 0 ? { batchId: null } : {}) }
      })
    },
    clearStaged() {
      update((state) => ({ ...state, staged: [], batchId: null }))
    },
    /** 提交成功后只移除已提交的 ops，保留提交期间新暂存的内容 */
    commitSubmitted(payload: BatchPayload) {
      update((state) => {
        const staged = state.staged.filter((op) => !payload.ops.includes(op))
        return { ...state, staged, ...(staged.length === 0 ? { batchId: null } : {}) }
      })
    },
    keepFailed(payload: BatchPayload, error: string) {
      update((state) => ({
        ...state,
        failed: [...state.failed.filter((entry) => entry.payload.batchId !== payload.batchId), { payload, error, at: new Date().toISOString() }],
      }))
    },
    dropFailed(batchId: string) {
      update((state) => ({ ...state, failed: state.failed.filter((entry) => entry.payload.batchId !== batchId) }))
    },
  }
}

export const reviewOutbox = createReviewOutbox()

export function validateCurriculum(state: CurriculumState) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  state.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  state.nodes.filter((node) => node.type === '毕业要求').forEach((node) => {
    if (!(outgoing.get(node.id) ?? []).some((mapping) => state.nodes.find((item) => item.id === mapping.target)?.type === '课程')) {
      issues.push({ id: `coverage-${node.id}`, severity: '错误', title: `${node.label.split('\n')[0]} 存在覆盖缺口`, detail: '未关联任何课程支撑证据。' })
    }
  })
  const seen = new Set<string>()
  state.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key)) issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}
