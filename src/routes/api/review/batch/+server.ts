import { json } from '@sveltejs/kit'
import { batchPayloadSchema } from '$lib/schema'
import { RepoError, submitBatch } from '$lib/server/repo'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  const parsed = batchPayloadSchema.safeParse(body)
  if (!parsed.success) {
    return json({ ok: false, message: '批次格式不正确', issues: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  try {
    const result = submitBatch(parsed.data)
    return json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof RepoError) {
      return json({ ok: false, message: error.message, retryable: error.status >= 500 }, { status: error.status })
    }
    throw error
  }
}
