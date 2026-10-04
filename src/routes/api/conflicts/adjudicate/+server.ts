import { json } from '@sveltejs/kit'
import { adjudicate } from '$lib/serverState'
import type { Role } from '$lib/merge'

export async function POST({ request }) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: '请求体无效。' }, { status: 400 })
  }
  const { conflictId, value, role } = body as { conflictId?: string; value?: unknown; role?: Role }
  if (!conflictId || value === undefined || !role) {
    return json({ error: '缺少 conflictId、value 或 role。' }, { status: 400 })
  }
  const result = adjudicate({ conflictId, value, role })
  return json(result)
}
