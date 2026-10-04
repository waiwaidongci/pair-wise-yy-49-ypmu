import { json } from '@sveltejs/kit'
import { getState } from '$lib/server/repo'

export function GET() {
  const state = getState()
  return json({
    nodes: state.nodes,
    mappings: state.mappings,
    reviewItems: state.reviewItems,
    revision: state.revision,
    mergePending: state.mergePending,
    updatedAt: new Date().toISOString(),
  })
}
