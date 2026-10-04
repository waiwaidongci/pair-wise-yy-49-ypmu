import { fail } from '@sveltejs/kit'
import { findSupportMapping, getState, RepoError, resolveConflict, submitBatch } from '$lib/server/repo'
import { resolveConflictSchema, revisionSubmitSchema } from '$lib/schema'
import type { FieldOp } from '$lib/merge'

export function load() {
  return getState()
}

/** 审阅记录 id 由内容决定：同一提交重试/补交时幂等命中，不重复生成记录 */
function contentItemId(parts: string) {
  let hash = 0
  for (let index = 0; index < parts.length; index += 1) hash = (hash * 31 + parts.charCodeAt(index)) >>> 0
  return `REV-${hash.toString(36).toUpperCase().padStart(6, '0').slice(-6)}`
}

export const actions = {
  submitRevision: async ({ request }) => {
    const form = await request.formData()
    const rawWeight = form.get('weight')
    const parsed = revisionSubmitSchema.safeParse({
      courseId: form.get('courseId'),
      requirementId: form.get('requirementId'),
      evidence: form.get('evidence'),
      revisionNote: form.get('revisionNote'),
      submitter: form.get('submitter'),
      weight: rawWeight === null || rawWeight === '' ? undefined : Number(rawWeight),
      baseRevision: form.get('baseRevision'),
      clientToken: form.get('clientToken'),
      role: form.get('role'),
    })
    if (!parsed.success) {
      return fail(400, { errors: parsed.error.flatten().fieldErrors, values: Object.fromEntries(form) })
    }
    const { courseId, requirementId, evidence, revisionNote, submitter, weight, baseRevision, clientToken, role } = parsed.data
    const ops: FieldOp[] = [
      {
        op: 'review.create',
        item: {
          id: contentItemId(`${courseId}|${requirementId}|${evidence}|${submitter}`),
          courseId,
          requirementId,
          evidence: `${evidence} 修订说明：${revisionNote}`,
          submitter,
          status: '待审阅',
          comment: '',
        },
      },
    ]
    if (weight !== undefined) {
      const mapping = findSupportMapping(requirementId, courseId)
      if (!mapping) {
        return fail(400, { errors: { weight: ['当前版本中不存在该毕业要求到课程的支撑映射'] }, values: Object.fromEntries(form) })
      }
      if (mapping.weight !== weight) ops.push({ op: 'mapping.weight', mappingId: mapping.id, value: weight })
    }
    try {
      const result = submitBatch({ batchId: `SUB-${clientToken}`, baseRevision, author: submitter, role, ops })
      if (result.conflicts.length > 0) {
        // 基线已变化：只拒绝冲突字段，其余字段已正常并入
        return fail(409, {
          message: `基线已变化：${result.conflicts.length} 个字段与当前版本冲突，仅冲突字段被拒绝并留待裁决，其余字段已并入 ${result.newRevision}`,
          conflictFields: result.conflicts.map((conflict) => ({
            key: conflict.key,
            base: conflict.baseValue,
            current: conflict.currentValue,
            incoming: conflict.incomingValue,
          })),
          newRevision: result.newRevision,
          applied: result.appliedSummaries,
        })
      }
      return { success: true, itemId: ops[0].op === 'review.create' ? ops[0].item.id : '', newRevision: result.newRevision, deduplicated: result.deduplicated }
    } catch (error) {
      if (error instanceof RepoError) return fail(error.status, { message: error.message, values: Object.fromEntries(form) })
      throw error
    }
  },
  resolveConflict: async ({ request }) => {
    const form = await request.formData()
    const parsed = resolveConflictSchema.safeParse({
      key: form.get('key'),
      choice: form.get('choice'),
      actor: form.get('actor'),
      role: form.get('role'),
    })
    if (!parsed.success) return fail(400, { message: '裁决参数不完整' })
    try {
      const result = resolveConflict(parsed.data)
      return { resolved: true, key: result.conflict.key, resolution: result.conflict.resolution, newRevision: result.newRevision, mergePending: result.mergePending }
    } catch (error) {
      if (error instanceof RepoError) return fail(error.status, { message: error.message })
      throw error
    }
  },
}
