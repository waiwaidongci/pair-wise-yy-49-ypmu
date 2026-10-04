import { mappings as seedMappings, nodes as seedNodes, reviewItems as seedReviewItems, seedState } from '$lib/seed'
import { applyOps, opLabel, setField, summarizeApplied, type BatchPayload, type Conflict, type FieldOp, type Role, type Snapshot } from '$lib/merge'

export type Revision = {
  id: string
  parent: string | null
  cause: string
  createdAt: string
  snapshot: Snapshot
}

export type BatchStatus = '已合并' | '待裁决' | '写入失败'

export type BatchRecord = {
  batchId: string
  baseRevision: string
  author: string
  role: Role
  ops: FieldOp[]
  status: BatchStatus
  attempts: number
  resultRevision: string | null
  appliedSummaries: string[]
  conflictKeys: string[]
  error?: string
  updatedAt: string
}

export type AuditEntry = {
  id: string
  batchId: string
  revision: string
  actor: string
  role: Role
  summary: string
  at: string
}

type RepoState = {
  revisions: Revision[]
  batches: Map<string, BatchRecord>
  conflicts: Map<string, Conflict>
  audit: AuditEntry[]
  revSeq: number
  auditSeq: number
}

/** 院系审阅人只能处理意见，不能改证据/权重，更不能裁决（裁决在 resolveConflict 单独校验） */
const ROLE_PERMISSIONS: Record<Role, Array<FieldOp['op']>> = {
  课程负责人: ['review.status', 'review.comment', 'review.evidence', 'mapping.weight', 'review.create'],
  院系审阅人: ['review.status', 'review.comment', 'review.create'],
}

export class RepoError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

function now() {
  return new Date().toISOString()
}

function initState(): RepoState {
  return {
    revisions: [
      {
        id: seedState.revision,
        parent: null,
        cause: '初始版本（种子数据）',
        createdAt: now(),
        snapshot: structuredClone({ reviewItems: seedReviewItems, mappings: seedMappings }),
      },
    ],
    batches: new Map(),
    conflicts: new Map(),
    audit: [],
    revSeq: Number(seedState.revision.slice(1)) || 12,
    auditSeq: 1,
  }
}

// 开发环境 HMR 下保持单例，避免模块重载丢失版本线
const globalForRepo = globalThis as unknown as { __curriculumRepo?: RepoState }
const state = (globalForRepo.__curriculumRepo ??= initState())

function currentRevision() {
  return state.revisions[state.revisions.length - 1]
}

function pendingCount() {
  return [...state.conflicts.values()].filter((entry) => entry.status === '待裁决').length
}

function sameBatchContent(record: BatchRecord, payload: BatchPayload) {
  return record.baseRevision === payload.baseRevision && JSON.stringify(record.ops) === JSON.stringify(payload.ops)
}

export function getState() {
  const current = currentRevision()
  const conflicts = [...state.conflicts.values()].sort((a, b) => (a.status === b.status ? a.key.localeCompare(b.key) : a.status === '待裁决' ? -1 : 1))
  return {
    revision: current.id,
    mergePending: pendingCount(),
    nodes: seedNodes,
    reviewItems: current.snapshot.reviewItems,
    mappings: current.snapshot.mappings,
    conflicts,
    audit: [...state.audit].slice(-40).reverse(),
    revisions: state.revisions.map((revision, index, all) => ({
      id: revision.id,
      parent: revision.parent,
      cause: revision.cause,
      createdAt: revision.createdAt,
      current: index === all.length - 1,
      // 旧版只读：非当前版本一律不可写，只能作为合并基线
      readOnly: index < all.length - 1,
      mergedInto: index < all.length - 1 ? all[index + 1].id : null,
    })),
    batches: [...state.batches.values()].map((batch) => ({
      batchId: batch.batchId,
      baseRevision: batch.baseRevision,
      author: batch.author,
      role: batch.role,
      status: batch.status,
      attempts: batch.attempts,
      resultRevision: batch.resultRevision,
      opCount: batch.ops.length,
      conflictKeys: batch.conflictKeys,
      error: batch.error,
      updatedAt: batch.updatedAt,
    })),
  }
}

export function findSupportMapping(requirementId: string, courseId: string) {
  return currentRevision().snapshot.mappings.find((mapping) => mapping.source === requirementId && mapping.target === courseId && mapping.relation === '支撑')
}

export type SubmitResult = {
  deduplicated: boolean
  status: BatchStatus
  batchId: string
  attempts: number
  newRevision: string | null
  appliedSummaries: string[]
  conflicts: Conflict[]
}

export function submitBatch(payload: BatchPayload): SubmitResult {
  const existing = state.batches.get(payload.batchId)
  if (existing) {
    if (!sameBatchContent(existing, payload)) {
      throw new RepoError(409, `批次 ${payload.batchId} 已提交过且内容不一致，请使用新的批次号`)
    }
    if (existing.status !== '写入失败') {
      // 幂等重试：直接返回首个处理结果，不重复生成审阅记录
      return {
        deduplicated: true,
        status: existing.status,
        batchId: existing.batchId,
        attempts: existing.attempts,
        newRevision: existing.resultRevision,
        appliedSummaries: existing.appliedSummaries,
        conflicts: existing.conflictKeys.map((key) => state.conflicts.get(key)).filter((conflict): conflict is Conflict => Boolean(conflict)),
      }
    }
    // 写入失败的批次：保留整批与基线，落入下方按原基线重新合并
  }

  const allowed = ROLE_PERMISSIONS[payload.role]
  const denied = payload.ops.filter((op) => !allowed.includes(op.op))
  if (denied.length > 0) {
    throw new RepoError(403, `角色「${payload.role}」无权提交：${denied.map((op) => opLabel(op)).join('、')}`)
  }

  const base = state.revisions.find((revision) => revision.id === payload.baseRevision)
  if (!base) throw new RepoError(409, `基线版本 ${payload.baseRevision} 不存在，无法合并`)

  const attempts = (existing?.attempts ?? 0) + 1
  const current = currentRevision()
  const outcome = applyOps(base.snapshot, current.snapshot, payload.ops, payload.batchId, payload.author)

  if (payload.simulateFailure) {
    state.batches.set(payload.batchId, {
      batchId: payload.batchId,
      baseRevision: payload.baseRevision,
      author: payload.author,
      role: payload.role,
      ops: payload.ops,
      status: '写入失败',
      attempts,
      resultRevision: null,
      appliedSummaries: [],
      conflictKeys: [],
      error: '模拟写入失败：批次与基线已保留',
      updatedAt: now(),
    })
    throw new RepoError(500, '写入失败：整批与基线已保留，可原样重试（重试不会重复生成审阅记录）')
  }

  // 提交点：先算好全部结果再一次性落库，失败不会留下半截版本
  const revision: Revision = {
    id: `R${++state.revSeq}`,
    parent: current.id,
    cause: `批次 ${payload.batchId} 合并（基线 ${payload.baseRevision}，${payload.author}）`,
    createdAt: now(),
    snapshot: outcome.snapshot,
  }
  state.revisions.push(revision)

  const conflictKeys: string[] = []
  for (const conflict of outcome.conflicts) {
    state.conflicts.set(conflict.key, conflict)
    conflictKeys.push(conflict.key)
  }

  const appliedSummaries: string[] = []
  for (const applied of outcome.applied) {
    if (applied.note === '记录已存在，幂等跳过') continue
    const summary = summarizeApplied(applied)
    appliedSummaries.push(summary)
    state.audit.push({ id: `AUD-${state.auditSeq++}`, batchId: payload.batchId, revision: revision.id, actor: payload.author, role: payload.role, summary, at: now() })
  }

  const record: BatchRecord = {
    batchId: payload.batchId,
    baseRevision: payload.baseRevision,
    author: payload.author,
    role: payload.role,
    ops: payload.ops,
    status: outcome.conflicts.length > 0 ? '待裁决' : '已合并',
    attempts,
    resultRevision: revision.id,
    appliedSummaries,
    conflictKeys,
    updatedAt: now(),
  }
  state.batches.set(payload.batchId, record)

  return { deduplicated: false, status: record.status, batchId: record.batchId, attempts, newRevision: revision.id, appliedSummaries, conflicts: outcome.conflicts }
}

export function resolveConflict(input: { key: string; choice: 'incoming' | 'current'; actor: string; role: Role }) {
  if (input.role !== '课程负责人') {
    throw new RepoError(403, '院系审阅人不能越权裁决：仅课程负责人可裁决冲突字段')
  }
  const conflict = state.conflicts.get(input.key)
  if (!conflict) throw new RepoError(404, `冲突 ${input.key} 不存在`)
  if (conflict.status === '已裁决') {
    return { deduplicated: true, conflict, newRevision: currentRevision().id, mergePending: pendingCount() }
  }
  const current = currentRevision()
  let revisionId = current.id
  if (input.choice === 'incoming') {
    const revision: Revision = {
      id: `R${++state.revSeq}`,
      parent: current.id,
      cause: `裁决 ${conflict.key} 采用提交方（${input.actor}）`,
      createdAt: now(),
      snapshot: setField(current.snapshot, conflict.op),
    }
    state.revisions.push(revision)
    revisionId = revision.id
  }
  conflict.status = '已裁决'
  conflict.resolution = input.choice === 'incoming' ? '采用提交方' : '保留系统方'
  conflict.resolvedBy = input.actor
  state.audit.push({ id: `AUD-${state.auditSeq++}`, batchId: conflict.batchId, revision: revisionId, actor: input.actor, role: input.role, summary: `裁决 ${opLabel(conflict.op)}：${conflict.resolution}`, at: now() })
  return { deduplicated: false, conflict, newRevision: revisionId, mergePending: pendingCount() }
}
