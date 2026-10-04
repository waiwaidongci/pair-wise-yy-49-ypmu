import type { Mapping, ReviewItem } from './seed'

export type Role = '课程负责人' | '院系审阅人'

/** 一个修订版本的完整快照：审阅记录（意见/证据）+ 映射权重 */
export type Snapshot = {
  reviewItems: ReviewItem[]
  mappings: Mapping[]
}

/** 字段级修改操作，批次提交时绑定处理时的修订版本 */
export type FieldOp =
  | { op: 'review.status'; itemId: string; value: ReviewItem['status'] }
  | { op: 'review.comment'; itemId: string; value: string }
  | { op: 'review.evidence'; itemId: string; value: string }
  | { op: 'mapping.weight'; mappingId: string; value: number }
  | { op: 'review.create'; item: ReviewItem }

export type BatchPayload = {
  /** 幂等键：同一批次重试不重复生成审阅记录 */
  batchId: string
  /** 处理时绑定的修订版本（三方合并的基线） */
  baseRevision: string
  author: string
  role: Role
  ops: FieldOp[]
  simulateFailure?: boolean
}

export type Conflict = {
  key: string
  op: FieldOp
  batchId: string
  author: string
  baseValue: string
  currentValue: string
  incomingValue: string
  status: '待裁决' | '已裁决'
  resolution?: '采用提交方' | '保留系统方'
  resolvedBy?: string
}

export type AppliedOp = { key: string; op: FieldOp; from: string; to: string; note?: string }

export function opKey(op: FieldOp): string {
  switch (op.op) {
    case 'review.create':
      return `review.create:${op.item.id}`
    case 'mapping.weight':
      return `mapping.weight:${op.mappingId}`
    default:
      return `${op.op}:${op.itemId}`
  }
}

export function opValue(op: FieldOp): string {
  switch (op.op) {
    case 'review.create':
      return op.item.evidence
    case 'mapping.weight':
      return String(op.value)
    default:
      return op.value
  }
}

export function opLabel(op: FieldOp): string {
  switch (op.op) {
    case 'review.status':
      return `${op.itemId} · 处理状态`
    case 'review.comment':
      return `${op.itemId} · 审阅意见`
    case 'review.evidence':
      return `${op.itemId} · 证据说明`
    case 'mapping.weight':
      return `${op.mappingId} · 支撑权重`
    case 'review.create':
      return `${op.item.id} · 新修订 ${op.item.courseId} → ${op.item.requirementId}`
  }
}

type SnapshotOp = Exclude<FieldOp, { op: 'review.create' }>

function readField(snapshot: Snapshot, op: SnapshotOp): string | undefined {
  switch (op.op) {
    case 'review.status':
      return snapshot.reviewItems.find((item) => item.id === op.itemId)?.status
    case 'review.comment':
      return snapshot.reviewItems.find((item) => item.id === op.itemId)?.comment
    case 'review.evidence':
      return snapshot.reviewItems.find((item) => item.id === op.itemId)?.evidence
    case 'mapping.weight': {
      const mapping = snapshot.mappings.find((entry) => entry.id === op.mappingId)
      return mapping ? String(mapping.weight) : undefined
    }
  }
}

export function setField(snapshot: Snapshot, op: FieldOp): Snapshot {
  switch (op.op) {
    case 'review.create':
      return { ...snapshot, reviewItems: [structuredClone(op.item), ...snapshot.reviewItems] }
    case 'review.status':
      return { ...snapshot, reviewItems: snapshot.reviewItems.map((item) => (item.id === op.itemId ? { ...item, status: op.value } : item)) }
    case 'review.comment':
      return { ...snapshot, reviewItems: snapshot.reviewItems.map((item) => (item.id === op.itemId ? { ...item, comment: op.value } : item)) }
    case 'review.evidence':
      return { ...snapshot, reviewItems: snapshot.reviewItems.map((item) => (item.id === op.itemId ? { ...item, evidence: op.value } : item)) }
    case 'mapping.weight':
      return { ...snapshot, mappings: snapshot.mappings.map((mapping) => (mapping.id === op.mappingId ? { ...mapping, weight: Math.round(op.value * 100) / 100 } : mapping)) }
  }
}

export type MergeOutcome = {
  snapshot: Snapshot
  applied: AppliedOp[]
  conflicts: Conflict[]
}

/**
 * 三方合并：以 base（处理时绑定的修订版本）为共同祖先，把整批操作合并到 current。
 * - 仅提交方改过的字段自动并入；
 * - 两边都改过且结果不同的字段留待裁决；
 * - 值已一致或记录已存在的操作幂等跳过，不重复生成审阅记录。
 */
export function applyOps(base: Snapshot, current: Snapshot, ops: FieldOp[], batchId: string, author: string): MergeOutcome {
  let snapshot = structuredClone(current)
  const applied: AppliedOp[] = []
  const conflicts: Conflict[] = []
  for (const op of ops) {
    const key = opKey(op)
    if (op.op === 'review.create') {
      if (snapshot.reviewItems.some((item) => item.id === op.item.id)) {
        applied.push({ key, op, from: '-', to: '-', note: '记录已存在，幂等跳过' })
        continue
      }
      snapshot = setField(snapshot, op)
      applied.push({ key, op, from: '-', to: op.item.id })
      continue
    }
    const baseValue = readField(base, op)
    const currentValue = readField(snapshot, op)
    const incoming = opValue(op)
    if (currentValue === undefined) {
      conflicts.push({ key, op, batchId, author, baseValue: baseValue ?? '', currentValue: '（目标不存在）', incomingValue: incoming, status: '待裁决' })
      continue
    }
    if (currentValue === incoming) {
      applied.push({ key, op, from: currentValue, to: incoming, note: '值已一致' })
      continue
    }
    if (currentValue === baseValue) {
      snapshot = setField(snapshot, op)
      applied.push({ key, op, from: baseValue ?? '', to: incoming })
      continue
    }
    conflicts.push({ key, op, batchId, author, baseValue: baseValue ?? '', currentValue, incomingValue: incoming, status: '待裁决' })
  }
  return { snapshot, applied, conflicts }
}

export function summarizeApplied(applied: AppliedOp): string {
  if (applied.op.op === 'review.create') return `新增审阅记录 ${applied.op.item.id}（${applied.op.item.courseId} → ${applied.op.item.requirementId}）`
  const from = applied.from === '' ? '（空）' : applied.from
  return `${opLabel(applied.op)}：${from} → ${applied.to}`
}
