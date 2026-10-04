import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem } from './seed'
import { seedState } from './seed'
import type { BatchRecord, Conflict, FieldChange, Role, VersionEntry } from './merge'

/**
 * 工作副本状态。服务端是权威源，这里只是响应式镜像。
 * 关键并发字段：
 *  - revision / baseline：当前版本与绑定基线；baseline !== revision 即旧版只读。
 *  - offline / pendingChanges：离线批次与待并入改动。
 *  - baselineSnapshot：绑定时的字段快照，作为三方合并的 base。
 *  - batches / conflicts / versions：批次、待裁决冲突、版本轨迹。
 */
type CurriculumState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  baseline: string
  baselineSnapshot: { mappings: Mapping[]; reviewItems: ReviewItem[] }
  role: Role
  offline: boolean
  pendingChanges: FieldChange[]
  batches: BatchRecord[]
  conflicts: Conflict[]
  versions: VersionEntry[]
  processedBatchIds: string[]
  draft: string
  lastError: string
  lastNotice: string
}

const saved = browser ? localStorage.getItem('curriculum-map-draft-v1') : null
const initial: CurriculumState = (() => {
  const base = saved ? JSON.parse(saved) : structuredClone(seedState)
  return {
    ...base,
    baseline: base.revision,
    baselineSnapshot: { mappings: structuredClone(base.mappings), reviewItems: structuredClone(base.reviewItems) },
    role: '负责人',
    offline: false,
    pendingChanges: [],
    batches: [],
    conflicts: [],
    versions: base.versions ?? [{ revision: base.revision, mergedAt: '初始版本', batchId: 'seed', note: '初始基线' }],
    processedBatchIds: base.processedBatchIds ?? [],
    draft: base.draft ?? 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
    lastError: '',
    lastNotice: '',
  }
})()

type ServerSnapshot = {
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

function applySnapshot(state: CurriculumState, snap: ServerSnapshot): CurriculumState {
  return {
    ...state,
    nodes: snap.nodes,
    mappings: snap.mappings,
    reviewItems: snap.reviewItems,
    revision: snap.revision,
    batches: snap.batches,
    conflicts: snap.conflicts,
    versions: snap.versions,
    processedBatchIds: snap.processedBatchIds,
    draft: snap.draft,
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function createCurriculumStore() {
  const { subscribe, update, set } = writable<CurriculumState>(initial)

  /** 合并成功后重设基线快照：当前值即为新基线；回到在线可写状态。 */
  function rebase(state: CurriculumState): CurriculumState {
    return {
      ...state,
      baseline: state.revision,
      offline: false,
      baselineSnapshot: { mappings: structuredClone(state.mappings), reviewItems: structuredClone(state.reviewItems) },
    }
  }

  return {
    subscribe,
    set,
    update,

    /** 从服务端权威状态拉取镜像。 */
    async hydrateFromServer() {
      if (!browser) return
      try {
        const res = await fetch('/api/curriculum')
        const snap: ServerSnapshot = await res.json()
        update((state) => rebase({ ...applySnapshot(state, snap), role: state.role, offline: false, pendingChanges: [], lastError: '', lastNotice: '' }))
      } catch {
        update((state) => ({ ...state, lastError: '无法连接服务端，当前为本地草稿。' }))
      }
    },

    setRole(role: Role) {
      update((state) => ({ ...state, role }))
    },

    /** 绑定当前版本为基线，进入离线编辑；期间改动只排队不写入。 */
    captureBaseline() {
      update((state) => ({
        ...state,
        baseline: state.revision,
        baselineSnapshot: { mappings: structuredClone(state.mappings), reviewItems: structuredClone(state.reviewItems) },
        offline: true,
        pendingChanges: [],
        lastNotice: `已绑定基线 ${state.revision}，进入离线编辑。`,
        lastError: '',
      }))
    },

    /** 离线排队：权重改动。base 取基线快照值。 */
    queueWeight(entityId: string, newValue: number) {
      update((state) => {
        const base = state.baselineSnapshot.mappings.find((m) => m.id === entityId)?.weight
        if (base === undefined) return state
        const changes = state.pendingChanges.filter(
          (c) => !(c.op === 'update' && c.entityType === 'mapping' && c.entityId === entityId && c.field === 'weight'),
        )
        changes.push({ op: 'update', entityType: 'mapping', entityId, field: 'weight', baseValue: base, newValue })
        return { ...state, pendingChanges: changes }
      })
    },

    /** 离线排队：证据改动。base 取基线快照值。 */
    queueEvidence(entityId: string, newValue: string) {
      update((state) => {
        const base = state.baselineSnapshot.reviewItems.find((r) => r.id === entityId)?.evidence
        if (base === undefined) return state
        const changes = state.pendingChanges.filter(
          (c) => !(c.op === 'update' && c.entityType === 'reviewItem' && c.entityId === entityId && c.field === 'evidence'),
        )
        changes.push({ op: 'update', entityType: 'reviewItem', entityId, field: 'evidence', baseValue: base, newValue })
        return { ...state, pendingChanges: changes }
      })
    },

    /** 离线排队：新增审阅记录。tempId 稳定，重试不重复生成。 */
    queueCreateReview(input: { courseId: string; requirementId: string; evidence: string; submitter: string }) {
      update((state) => {
        const tempId = `REV-${state.baseline}-${Date.now().toString(36)}`
        const changes = state.pendingChanges.filter((c) => !(c.op === 'createReview' && c.tempId === tempId))
        changes.push({ op: 'createReview', tempId, ...input })
        return { ...state, pendingChanges: changes, lastNotice: '已加入离线批次，提交后并入。' }
      })
    },

    removePendingChange(index: number) {
      update((state) => ({ ...state, pendingChanges: state.pendingChanges.filter((_, i) => i !== index) }))
    },

    /** 提交离线批次到服务端做三方合并。 */
    async submitBatch(simulateFailure = false) {
      let batchId = ''
      let baseline = ''
      let changes: FieldChange[] = []
      let role: Role = '负责人'
      update((state) => {
        batchId = `B-${Date.now().toString(36)}`
        baseline = state.baseline
        changes = structuredClone(state.pendingChanges)
        role = state.role
        return state
      })
      if (changes.length === 0) {
        update((state) => ({ ...state, lastError: '批次为空，没有可并入的改动。' }))
        return
      }
      try {
        const result = await postJson<{
          kind: 'idempotent' | 'failed' | 'conflict' | 'merged'
          state: ServerSnapshot
          error?: string
          conflicts?: Conflict[]
          newRevision?: string
          message?: string
        }>('/api/merge', { batchId, baseline, role, changes, simulateFailure })

        update((state) => {
          let next = applySnapshot(state, result.state)
          if (result.kind === 'merged') {
            next = rebase({ ...next, offline: false, pendingChanges: [], lastNotice: `批次 ${batchId} 已并入，新版本 ${result.newRevision}。`, lastError: '' })
          } else if (result.kind === 'idempotent') {
            next = rebase({ ...next, offline: false, pendingChanges: [], lastNotice: result.message ?? '该批次已并入。', lastError: '' })
          } else if (result.kind === 'conflict') {
            next = { ...next, offline: true, pendingChanges: [], lastError: '', lastNotice: `批次 ${batchId}：${result.conflicts?.length ?? 0} 项冲突待裁决，非冲突字段已并入。` }
          } else {
            next = { ...next, offline: true, pendingChanges: [], lastError: result.error ?? '写入失败，整批与基线已保留。', lastNotice: '' }
          }
          return next
        })
      } catch {
        update((state) => ({ ...state, lastError: '提交失败：整批与基线已保留，可重试。' }))
      }
    },

    /** 重试失败/冲突批次：整批与基线仍在；幂等不重复生成审阅记录。 */
    async retryBatch(batchId: string, simulateFailure = false) {
      try {
        const result = await postJson<{
          kind: 'idempotent' | 'failed' | 'conflict' | 'merged'
          state: ServerSnapshot
          error?: string
          conflicts?: Conflict[]
          newRevision?: string
          message?: string
        }>('/api/merge', { batchId, retry: true, simulateFailure })

        update((state) => {
          let next = applySnapshot(state, result.state)
          if (result.kind === 'merged' || result.kind === 'idempotent') {
            next = rebase({ ...next, offline: false, pendingChanges: [], lastNotice: result.kind === 'merged' ? `批次已并入，新版本 ${result.newRevision}。` : (result.message ?? '已并入。'), lastError: '' })
          } else if (result.kind === 'conflict') {
            next = { ...next, offline: true, pendingChanges: [], lastError: '', lastNotice: `${result.conflicts?.length ?? 0} 项冲突待裁决。` }
          } else {
            next = { ...next, offline: true, pendingChanges: [], lastError: result.error ?? '重试失败，整批与基线仍保留。', lastNotice: '' }
          }
          return next
        })
      } catch {
        update((state) => ({ ...state, lastError: '重试失败：整批与基线仍保留。' }))
      }
    },

    /** 审阅人处理意见：系统侧直接并入并推进版本。旧版/离线时只读，UI 门禁。 */
    async decideReview(itemId: string, status: '已附议' | '已退回', comment: string) {
      try {
        const result = await postJson<{ state: ServerSnapshot; newRevision: string }>('/api/review/decide', { itemId, status, comment })
        update((state) => rebase({ ...applySnapshot(state, result.state), lastNotice: `审阅意见已并入，新版本 ${result.newRevision}。`, lastError: '' }))
      } catch {
        update((state) => ({ ...state, lastError: '审阅意见提交失败。' }))
      }
    },

    /** 负责人裁决冲突；审阅人越权会被服务端拒绝。 */
    async adjudicate(conflictId: string, value: unknown) {
      let role: Role = '负责人'
      update((state) => {
        role = state.role
        return state
      })
      try {
        const result = await postJson<{ ok: boolean; state: ServerSnapshot; newRevision?: string; error?: string }>('/api/conflicts/adjudicate', { conflictId, value, role })
        update((state) => {
          if (result.ok) {
            return rebase({ ...applySnapshot(state, result.state), lastNotice: '冲突已裁决并并入。', lastError: '' })
          }
          return { ...applySnapshot(state, result.state), lastError: result.error ?? '裁决被拒绝。' }
        })
      } catch {
        update((state) => ({ ...state, lastError: '裁决提交失败。' }))
      }
    },

    /** 在线编辑：直接系统侧并入并推进版本。仅当前版本可写。 */
    async mutate(op: 'addMapping' | 'updateWeight' | 'updateEvidence' | 'createReview' | 'updateDraft', payload: Record<string, unknown>) {
      try {
        const result = await postJson<{ state: ServerSnapshot; newRevision: string }>('/api/mutate', { op, payload })
        update((state) => rebase({ ...applySnapshot(state, result.state), lastNotice: `已并入，新版本 ${result.newRevision}。`, lastError: '' }))
      } catch {
        update((state) => ({ ...state, lastError: '编辑提交失败。' }))
      }
    },

    /** 兼容旧入口：锁定即绑定基线进入离线。 */
    lock(revision?: string) {
      update((state) => ({
        ...state,
        baseline: revision ?? state.revision,
        baselineSnapshot: { mappings: structuredClone(state.mappings), reviewItems: structuredClone(state.reviewItems) },
        offline: true,
        pendingChanges: [],
      }))
    },

    saveDraft(draft: string) {
      update((state) => ({ ...state, draft }))
      void this.mutate('updateDraft', { draft })
    },

    moveNode(id: string, x: number, y: number) {
      update((state) => ({ ...state, nodes: state.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) }))
    },

    addMapping(source: string, target: string, relation: Mapping['relation'], weight: number) {
      void this.mutate('addMapping', { source, target, relation, weight })
    },

    updateReview(id: string, status: ReviewItem['status'], comment: string) {
      if (status === '已附议' || status === '已退回') void this.decideReview(id, status, comment)
    },
  }
}

export const curriculumStore = createCurriculumStore()

if (browser) {
  curriculumStore.subscribe((state) => localStorage.setItem('curriculum-map-draft-v1', JSON.stringify(state)))
}

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
