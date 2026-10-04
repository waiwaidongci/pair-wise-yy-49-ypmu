import { nodes, mappings, reviewItems, seedState, type GraphNode, type Mapping, type ReviewItem } from './seed'
import {
  mergeChanges,
  adjudicateConflict,
  type BatchRecord,
  type Conflict,
  type FieldChange,
  type Role,
  type VersionEntry,
} from './merge'

/**
 * 服务端权威状态。客户端只是响应式镜像：所有并发改动都经服务端三方合并后返回快照。
 * 版本号 revision 单调递增；baseline 是工作副本绑定的基线，用于只读判定。
 */
export type ServerSnapshot = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  role: Role
  batches: BatchRecord[]
  conflicts: Conflict[]
  versions: VersionEntry[]
  processedBatchIds: string[]
  draft: string
  updatedAt: string
}

type ServerState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  role: Role
  batches: BatchRecord[]
  conflicts: Conflict[]
  versions: VersionEntry[]
  processedBatchIds: string[]
  draft: string
}

const initial: ServerState = {
  nodes: structuredClone(nodes),
  mappings: structuredClone(mappings),
  reviewItems: structuredClone(reviewItems),
  revision: seedState.revision,
  role: '负责人',
  batches: [],
  conflicts: [],
  versions: [{ revision: seedState.revision, mergedAt: '初始版本', batchId: 'seed', note: '初始基线' }],
  processedBatchIds: [],
  draft: 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
}

const state: ServerState = structuredClone(initial)

let revisionCounter = 12
function nextRevision(): string {
  revisionCounter += 1
  return `R${revisionCounter}`
}

function snapshot(): ServerSnapshot {
  return {
    nodes: structuredClone(state.nodes),
    mappings: structuredClone(state.mappings),
    reviewItems: structuredClone(state.reviewItems),
    revision: state.revision,
    role: state.role,
    batches: structuredClone(state.batches),
    conflicts: structuredClone(state.conflicts),
    versions: structuredClone(state.versions),
    processedBatchIds: [...state.processedBatchIds],
    draft: state.draft,
    updatedAt: new Date().toISOString(),
  }
}

/** 应用一批自动合并的字段改动（非冲突部分）。 */
function applyAutoMerged(autoMerged: ReturnType<typeof mergeChanges>['autoMerged']) {
  for (const change of autoMerged) {
    if (change.field === '__create__') {
      const draft = change.value as Extract<FieldChange, { op: 'createReview' }>
      if (state.reviewItems.some((r) => r.id === draft.tempId)) continue // 幂等：已存在则不重复生成
      state.reviewItems.unshift({
        id: draft.tempId,
        courseId: draft.courseId,
        requirementId: draft.requirementId,
        evidence: draft.evidence,
        submitter: draft.submitter,
        status: '待审阅',
        comment: '',
      })
      continue
    }
    if (change.entityType === 'mapping') {
      const target = state.mappings.find((m) => m.id === change.entityId)
      if (target) (target as Record<string, unknown>)[change.field] = change.value
    } else {
      const target = state.reviewItems.find((r) => r.id === change.entityId)
      if (target) (target as Record<string, unknown>)[change.field] = change.value
    }
  }
}

function allConflictsResolved(batchId: string): boolean {
  return !state.conflicts.some((c) => c.batchId === batchId && c.status === 'pending')
}

export type SubmitResult =
  | { kind: 'idempotent'; state: ServerSnapshot; message: string }
  | { kind: 'failed'; state: ServerSnapshot; error: string }
  | { kind: 'conflict'; state: ServerSnapshot; conflicts: Conflict[] }
  | { kind: 'merged'; state: ServerSnapshot; newRevision: string; autoMergedCount: number }

/**
 * 提交离线批次做三方合并。
 * - 幂等：batchId 已处理则直接返回既有结果，不重复生成审阅记录。
 * - 写入失败：保留整批与基线，不写入任何改动，等待重试。
 * - 冲突：只拒绝两边都改过的字段（留待裁决），非冲突字段照常并入。
 */
export function submitBatch(input: {
  batchId: string
  baseline: string
  role: Role
  changes: FieldChange[]
  simulateFailure?: boolean
}): SubmitResult {
  const { batchId, baseline, role, changes, simulateFailure } = input

  if (state.processedBatchIds.includes(batchId)) {
    return { kind: 'idempotent', state: snapshot(), message: '该批次已并入，未重复生成审阅记录。' }
  }

  const existing = state.batches.find((b) => b.id === batchId)
  const attempts = (existing?.attempts ?? 0) + 1

  // 写入失败：保留整批与基线，不写入任何改动，等待重试。
  if (simulateFailure) {
    const record: BatchRecord = {
      id: batchId,
      baseline,
      role,
      changes,
      status: 'failed',
      attempts,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastError: '模拟写入失败：整批与基线已保留，可重试。',
    }
    state.batches = state.batches.filter((b) => b.id !== batchId)
    state.batches.push(record)
    return { kind: 'failed', state: snapshot(), error: record.lastError! }
  }

  const outcome = mergeChanges({ mappings: state.mappings, reviewItems: state.reviewItems, changes, batchId })
  applyAutoMerged(outcome.autoMerged)

  const hadConflicts = outcome.conflicts.length > 0
  const record: BatchRecord = {
    id: batchId,
    baseline,
    role,
    changes,
    status: hadConflicts ? 'conflict' : 'merged',
    attempts,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  state.batches = state.batches.filter((b) => b.id !== batchId)
  state.batches.push(record)

  if (hadConflicts) {
    state.conflicts = state.conflicts.filter((c) => c.batchId !== batchId).concat(outcome.conflicts)
    return { kind: 'conflict', state: snapshot(), conflicts: outcome.conflicts }
  }

  state.processedBatchIds.push(batchId)
  const newRevision = nextRevision()
  state.revision = newRevision
  state.versions.push({ revision: newRevision, mergedAt: new Date().toISOString(), batchId, note: `批次 ${batchId} 并入` })
  return { kind: 'merged', state: snapshot(), newRevision, autoMergedCount: outcome.autoMerged.length }
}

/** 重试失败或冲突的批次：整批与基线仍在，重新三方合并；幂等不重复生成审阅记录。 */
export function retryBatch(input: { batchId: string; simulateFailure?: boolean }): SubmitResult {
  const batch = state.batches.find((b) => b.id === input.batchId)
  if (!batch) return { kind: 'failed', state: snapshot(), error: '批次不存在。' }
  return submitBatch({
    batchId: batch.id,
    baseline: batch.baseline,
    role: batch.role,
    changes: batch.changes,
    simulateFailure: input.simulateFailure,
  })
}

/** 院系审阅人处理意见：直接在系统侧并入，推进版本。 */
export function decideReview(input: {
  itemId: string
  status: '已附议' | '已退回'
  comment: string
}): { state: ServerSnapshot; newRevision: string } {
  const target = state.reviewItems.find((r) => r.id === input.itemId)
  if (target) {
    target.status = input.status
    target.comment = input.comment
  }
  const newRevision = nextRevision()
  state.revision = newRevision
  state.versions.push({ revision: newRevision, mergedAt: new Date().toISOString(), batchId: 'review', note: `审阅意见 ${input.itemId}` })
  return { state: snapshot(), newRevision }
}

/** 负责人裁决冲突：仅负责人可裁决；裁决后若该批次冲突全部解决，则批次并入并推进版本。 */
export function adjudicate(input: { conflictId: string; value: unknown; role: Role }):
  | { ok: true; state: ServerSnapshot; newRevision: string }
  | { ok: false; state: ServerSnapshot; error: string } {
  const conflict = state.conflicts.find((c) => c.id === input.conflictId)
  if (!conflict) return { ok: false, state: snapshot(), error: '冲突不存在。' }
  try {
    const updated = adjudicateConflict(conflict, input.value, input.role)
    state.conflicts = state.conflicts.map((c) => (c.id === input.conflictId ? updated : c))
    if (updated.entityType === 'mapping') {
      const target = state.mappings.find((m) => m.id === updated.entityId)
      if (target) (target as Record<string, unknown>)[updated.field] = updated.adjudicatedValue
    } else {
      const target = state.reviewItems.find((r) => r.id === updated.entityId)
      if (target) (target as Record<string, unknown>)[updated.field] = updated.adjudicatedValue
    }
  } catch (err) {
    return { ok: false, state: snapshot(), error: (err as Error).message }
  }

  if (allConflictsResolved(conflict.batchId)) {
    const batch = state.batches.find((b) => b.id === conflict.batchId)
    if (batch && batch.status === 'conflict') {
      batch.status = 'merged'
      state.processedBatchIds.push(batch.id)
      const newRevision = nextRevision()
      state.revision = newRevision
      state.versions.push({ revision: newRevision, mergedAt: new Date().toISOString(), batchId: batch.id, note: `批次 ${batch.id} 裁决完成并入` })
      return { ok: true, state: snapshot(), newRevision }
    }
  }
  return { ok: true, state: snapshot(), newRevision: state.revision }
}

/** 在线直接编辑（非离线批次）：系统侧改动，推进版本。 */
export function mutate(input: {
  op: 'addMapping' | 'updateWeight' | 'updateEvidence' | 'createReview' | 'updateDraft'
  payload: Record<string, unknown>
}): { state: ServerSnapshot; newRevision: string } {
  const { op, payload } = input
  if (op === 'addMapping') {
    state.mappings.push({
      id: `M-${Date.now()}`,
      source: payload.source as string,
      target: payload.target as string,
      relation: payload.relation as Mapping['relation'],
      weight: payload.weight as number,
    })
  } else if (op === 'updateWeight') {
    const target = state.mappings.find((m) => m.id === payload.entityId)
    if (target) target.weight = payload.weight as number
  } else if (op === 'updateEvidence') {
    const target = state.reviewItems.find((r) => r.id === payload.entityId)
    if (target) target.evidence = payload.evidence as string
  } else if (op === 'createReview') {
    const id = `REV-${Date.now().toString().slice(-4)}`
    state.reviewItems.unshift({
      id,
      courseId: payload.courseId as string,
      requirementId: payload.requirementId as string,
      evidence: payload.evidence as string,
      submitter: payload.submitter as string,
      status: '待审阅',
      comment: '',
    })
  } else if (op === 'updateDraft') {
    state.draft = payload.draft as string
  }
  const newRevision = nextRevision()
  state.revision = newRevision
  state.versions.push({ revision: newRevision, mergedAt: new Date().toISOString(), batchId: 'mutate', note: `在线编辑 ${op}` })
  return { state: snapshot(), newRevision }
}

export function getState(): ServerSnapshot {
  return snapshot()
}
