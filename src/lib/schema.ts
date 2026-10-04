import { z } from 'zod'

export const roleSchema = z.enum(['课程负责人', '院系审阅人'])

export const reviewItemSchema = z.object({
  id: z.string().min(1),
  courseId: z.string().min(1),
  requirementId: z.string().min(1),
  evidence: z.string().min(1),
  submitter: z.string().min(1),
  status: z.enum(['待审阅', '已附议', '已退回']),
  comment: z.string(),
})

export const fieldOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('review.status'), itemId: z.string().min(1), value: z.enum(['待审阅', '已附议', '已退回']) }),
  z.object({ op: z.literal('review.comment'), itemId: z.string().min(1), value: z.string().min(1, '审阅意见不能为空') }),
  z.object({ op: z.literal('review.evidence'), itemId: z.string().min(1), value: z.string().min(12, '证据说明至少需要 12 个字符') }),
  z.object({ op: z.literal('mapping.weight'), mappingId: z.string().min(1), value: z.number().min(0).max(1) }),
  z.object({ op: z.literal('review.create'), item: reviewItemSchema }),
])

/** 整批提交：必须绑定处理时的修订版本，batchId 作为幂等键 */
export const batchPayloadSchema = z.object({
  batchId: z.string().min(6),
  baseRevision: z.string().min(1, '必须绑定处理时的修订版本'),
  author: z.string().min(1),
  role: roleSchema,
  ops: z.array(fieldOpSchema).min(1, '批次至少包含一项修改'),
  simulateFailure: z.boolean().optional(),
})

export const revisionSubmitSchema = z.object({
  courseId: z.string().min(1, '请选择课程'),
  requirementId: z.string().min(1, '请选择毕业要求'),
  evidence: z.string().min(12, '证据说明至少需要 12 个字符'),
  revisionNote: z.string().min(8, '修订说明至少需要 8 个字符'),
  submitter: z.string().min(2, '请填写提交人'),
  weight: z.number().min(0, '权重需在 0 与 1 之间').max(1, '权重需在 0 与 1 之间').optional(),
  baseRevision: z.string().min(1, '必须绑定处理时的修订版本'),
  clientToken: z.string().min(6),
  role: roleSchema,
})

export const resolveConflictSchema = z.object({
  key: z.string().min(1),
  choice: z.enum(['incoming', 'current']),
  actor: z.string().min(1),
  role: roleSchema,
})

export const mappingSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.enum(['支撑', '前置', '考核', '教学']),
  weight: z.number().min(0).max(1),
})

export type RevisionInput = z.infer<typeof revisionSubmitSchema>
