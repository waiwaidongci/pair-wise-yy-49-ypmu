import { json } from '@sveltejs/kit'
import { submitBatch, retryBatch } from '$lib/serverState'
import type { FieldChange, Role } from '$lib/merge'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: '请求体无效。' }, { status: 400 })
  }

  const { batchId, baseline, role, changes, simulateFailure, retry } = body as {
    batchId?: string
    baseline?: string
    role?: Role
    changes?: FieldChange[]
    simulateFailure?: boolean
    retry?: boolean
  }

  if (retry && batchId) {
    const result = retryBatch({ batchId, simulateFailure: !!simulateFailure })
    return json(result)
  }

  if (!batchId || !baseline || !Array.isArray(changes)) {
    return json({ error: '缺少 batchId、baseline 或 changes。' }, { status: 400 })
  }

  const result = submitBatch({
    batchId,
    baseline,
    role: role ?? '负责人',
    changes,
    simulateFailure: !!simulateFailure,
  })
  return json(result)
}
