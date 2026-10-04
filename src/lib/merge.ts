import type { Mapping, ReviewItem } from './seed'

/**
 * 并发审阅的核心类型：版本绑定 + 三方字段级合并。
 *
 * 负责人离线修改证据与权重，回到系统提交时，以「离线批次」为单位做三方合并：
 *   base    = 批次绑定时的基线值
 *   ours    = 离线批次里改过的值
 *   theirs  = 系统当前值（审阅人在旧版本上处理后已并入的值）
 * 只有 ours 与 theirs 相对 base 都发生变化且不一致时，才判为冲突，留待裁决。
 */

export type Role = '负责人' | '审阅人'

export type FieldChange =
  | {
      op: 'update'
      entityType: 'mapping'
      entityId: string
      field: 'weight'
      baseValue: number
      newValue: number
    }
  | {
      op: 'update'
      entityType: 'reviewItem'
      entityId: string
      field: 'evidence' | 'comment' | 'status'
      baseValue: string
      newValue: string
    }
  | {
      op: 'createReview'
      tempId: string
      courseId: string
      requirementId: string
      evidence: string
      submitter: string
    }

export type Conflict = {
  id: string
  batchId: string
  entityType: 'mapping' | 'reviewItem'
  entityId: string
  field: string
  label: string
  baseValue: unknown
  oursValue: unknown
  theirsValue: unknown
  status: 'pending' | 'adjudicated'
  adjudicatedValue?: unknown
  adjudicatedBy?: Role
}

export type AutoMerge = {
  entityType: 'mapping' | 'reviewItem'
  entityId: string
  field: string
  label: string
  value: unknown
  source: 'ours' | 'theirs' | 'same'
}

export type MergeOutcome = {
  ok: boolean
  autoMerged: AutoMerge[]
  conflicts: Conflict[]
  createdReviewIds: string[]
}

export type BatchRecord = {
  id: string
  baseline: string
  role: Role
  changes: FieldChange[]
  status: 'pending' | 'merged' | 'conflict' | 'failed'
  attempts: number
  createdAt: string
  lastError?: string
}

export type VersionEntry = {
  revision: string
  mergedAt: string
  batchId: string
  note: string
}

export const FIELD_LABELS: Record<string, string> = {
  weight: '权重',
  evidence: '证据说明',
  comment: '审阅意见',
  status: '审阅状态',
}

export function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return false
}

/**
 * 单字段三方合并。
 * 规则：
 *  - 我们没改        -> 采用 theirs（系统侧的变化）
 *  - 他们没改        -> 采用 ours（离线侧的变化）
 *  - 两边都改且一致  -> 采用该值
 *  - 两边都改且不一致 -> 冲突，留待裁决
 */
export function mergeValue(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): { value: unknown; conflict: boolean; source: 'ours' | 'theirs' | 'same' | 'conflict' } {
  const changedByUs = !isEqual(ours, base)
  const changedByThem = !isEqual(theirs, base)
  if (!changedByUs) return { value: theirs, conflict: false, source: 'theirs' }
  if (!changedByThem) return { value: ours, conflict: false, source: 'ours' }
  if (isEqual(ours, theirs)) return { value: ours, conflict: false, source: 'same' }
  return { value: theirs, conflict: true, source: 'conflict' }
}

function readField(mappings: Mapping[], reviewItems: ReviewItem[], entityType: string, entityId: string, field: string): unknown {
  if (entityType === 'mapping') return mappings.find((m) => m.id === entityId)?.[field as keyof Mapping]
  return reviewItems.find((r) => r.id === entityId)?.[field as keyof ReviewItem]
}

/**
 * 对一批离线改动做三方字段级合并。纯函数，不写入状态。
 * 新审阅记录（createReview）始终视为 ours 侧新增，不产生字段冲突；幂等由调用方按 tempId 去重。
 */
export function mergeChanges(args: {
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  changes: FieldChange[]
  batchId: string
}): MergeOutcome {
  const { mappings, reviewItems, changes, batchId } = args
  const autoMerged: AutoMerge[] = []
  const conflicts: Conflict[] = []
  const createdReviewIds: string[] = []

  for (const change of changes) {
    if (change.op === 'createReview') {
      createdReviewIds.push(change.tempId)
      autoMerged.push({
        entityType: 'reviewItem',
        entityId: change.tempId,
        field: '__create__',
        label: '新增审阅记录',
        value: change,
        source: 'ours',
      })
      continue
    }

    const theirs = readField(mappings, reviewItems, change.entityType, change.entityId, change.field)
    const { value, conflict, source } = mergeValue(change.baseValue, change.newValue, theirs)
    const label = FIELD_LABELS[change.field] ?? change.field
    if (conflict) {
      conflicts.push({
        id: `C-${batchId}-${change.entityId}-${change.field}`,
        batchId,
        entityType: change.entityType,
        entityId: change.entityId,
        field: change.field,
        label,
        baseValue: change.baseValue,
        oursValue: change.newValue,
        theirsValue: theirs,
        status: 'pending',
      })
    } else {
      autoMerged.push({
        entityType: change.entityType,
        entityId: change.entityId,
        field: change.field,
        label,
        value,
        source: source as AutoMerge['source'],
      })
    }
  }

  return { ok: conflicts.length === 0, autoMerged, conflicts, createdReviewIds }
}

/** 裁决冲突：仅负责人可裁决；审阅人越权直接拒绝。 */
export function adjudicateConflict(conflict: Conflict, value: unknown, role: Role): Conflict {
  if (role !== '负责人') {
    throw new Error('院系审阅人无权裁决冲突，请联系课程负责人处理。')
  }
  return { ...conflict, status: 'adjudicated', adjudicatedValue: value, adjudicatedBy: role }
}
