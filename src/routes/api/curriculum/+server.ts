import { json } from '@sveltejs/kit'
import { getState } from '$lib/serverState'

export function GET() {
  return json(getState())
}
