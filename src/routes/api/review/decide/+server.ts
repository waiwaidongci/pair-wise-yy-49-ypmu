import { json } from '@sveltejs/kit'
import { decideReview } from '$lib/serverState'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: '请求体无效。' }, { status: 400 })
  }
  const { itemId, status, comment } = body as {
    itemId?: string
    status?: '已附议' | '已退回'
    comment?: string
  }
  if (!itemId || !status) {
    return json({ error: '缺少 itemId 或 status。' }, { status: 400 })
  }
  const result = decideReview({ itemId, status, comment: comment ?? '' })
  return json(result)
}
