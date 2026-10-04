import { json } from '@sveltejs/kit'
import { mutate } from '$lib/serverState'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: '请求体无效。' }, { status: 400 })
  }
  const { op, payload } = body as { op?: string; payload?: Record<string, unknown> }
  const allowed = ['addMapping', 'updateWeight', 'updateEvidence', 'createReview', 'updateDraft']
  if (!op || !allowed.includes(op)) {
    return json({ error: `不支持的操作：${op ?? '未知'}。` }, { status: 400 })
  }
  const result = mutate({ op: op as 'addMapping', payload: payload ?? {} })
  return json(result)
}
