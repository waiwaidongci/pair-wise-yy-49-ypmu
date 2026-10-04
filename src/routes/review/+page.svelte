<script lang="ts">
  import { enhance } from '$app/forms'
  import { invalidateAll } from '$app/navigation'
  import type { ActionData, PageData } from './$types'
  import { actorStore, curriculumStore, reviewOutbox, roleStore } from '$lib/stores'
  import { opLabel, opValue, type BatchPayload, type FieldOp } from '$lib/merge'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  let reviewComments = $state<Record<string, string>>({})
  let evidenceDrafts = $state<Record<string, string>>({})
  let weightDrafts = $state<Record<string, number>>({})
  let simulateFailure = $state(false)
  let submitting = $state(false)
  let batchMessage = $state<string | null>(null)
  let clientToken = $state(newClientToken())

  function newClientToken() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }

  // 服务端是合并后的真实来源：同步到共享 store，覆盖矩阵与课程地图导出随之重算
  $effect(() => {
    curriculumStore.applyServerState({ mappings: data.mappings, reviewItems: data.reviewItems, revision: data.revision })
  })
  // 没有暂存内容时，处理基线跟随系统当前版本
  $effect(() => {
    reviewOutbox.bindBase(data.revision)
  })

  const courses = $derived(data.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived(data.nodes.filter((node) => node.type === '毕业要求'))
  const supportMappings = $derived(data.mappings.filter((mapping) => mapping.relation === '支撑' && mapping.source.startsWith('GR-') && mapping.target.startsWith('C-')))
  const pendingItems = $derived(data.reviewItems.filter((item) => item.status === '待审阅'))
  const pendingConflicts = $derived(data.conflicts.filter((conflict) => conflict.status === '待裁决'))
  const resolvedConflicts = $derived(data.conflicts.filter((conflict) => conflict.status === '已裁决'))
  const staleBase = $derived($reviewOutbox.staged.length > 0 && $reviewOutbox.baseRevision !== null && $reviewOutbox.baseRevision !== data.revision)

  const formMessage = $derived(form && 'message' in form ? String(form.message) : null)
  const formErrors = $derived(form && 'errors' in form ? (form.errors as Record<string, string[]>) : null)
  const formSuccess = $derived(form && 'success' in form ? form : null)
  const formConflicts = $derived(form && 'conflictFields' in form ? form.conflictFields : null)
  const formResolved = $derived(form && 'resolved' in form ? form : null)

  function nodeLabel(id: string) {
    return data.nodes.find((node) => node.id === id)?.label.split('\n')[0] ?? id
  }

  function short(value: string, length = 42) {
    return value.length > length ? `${value.slice(0, length)}…` : value
  }

  function stagedOp<T extends 'review.status' | 'review.comment' | 'review.evidence'>(itemId: string, op: T) {
    return $reviewOutbox.staged.find((entry): entry is Extract<FieldOp, { op: T }> => entry.op === op && 'itemId' in entry && entry.itemId === itemId)
  }

  function stageReview(itemId: string, status: '已附议' | '已退回') {
    const comment = reviewComments[itemId] || (status === '已附议' ? '证据充分，同意纳入修订。' : '请补充可验证的评分记录。')
    reviewOutbox.stage({ op: 'review.status', itemId, value: status }, data.revision)
    reviewOutbox.stage({ op: 'review.comment', itemId, value: comment }, data.revision)
  }

  function stageAllApprove() {
    for (const item of pendingItems) {
      reviewOutbox.stage({ op: 'review.status', itemId: item.id, value: '已附议' }, data.revision)
      reviewOutbox.stage({ op: 'review.comment', itemId: item.id, value: reviewComments[item.id] || '批量附议：证据链完整。' }, data.revision)
    }
  }

  function stageEvidence(itemId: string, current: string) {
    const value = (evidenceDrafts[itemId] ?? current).trim()
    if (value.length < 12 || value === current) return
    reviewOutbox.stage({ op: 'review.evidence', itemId, value }, data.revision)
  }

  function stageWeight(mappingId: string) {
    const value = weightDrafts[mappingId]
    if (value === undefined || value === null || Number.isNaN(value) || value < 0 || value > 1) return
    reviewOutbox.stage({ op: 'mapping.weight', mappingId, value }, data.revision)
  }

  function buildPayload(): BatchPayload {
    return {
      batchId: $reviewOutbox.batchId ?? '',
      baseRevision: $reviewOutbox.baseRevision ?? data.revision,
      author: $actorStore,
      role: $roleStore,
      ops: $reviewOutbox.staged,
      simulateFailure,
    }
  }

  async function submitBatch(payload: BatchPayload, isRetry: boolean) {
    if (submitting || payload.ops.length === 0) return
    submitting = true
    batchMessage = null
    try {
      const response = await fetch('/api/review/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isRetry ? { ...payload, simulateFailure: false } : payload),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body?.ok) {
        const message = body?.message ?? `提交失败（HTTP ${response.status}）`
        if (response.status >= 500 || response.status === 0) {
          // 写入失败：整批与基线保留在失败队列，可原样重试
          reviewOutbox.keepFailed(payload, message)
          batchMessage = `${message}；整批与基线已保留，可重试。`
        } else {
          batchMessage = message
        }
        return
      }
      reviewOutbox.commitSubmitted(payload)
      reviewOutbox.dropFailed(payload.batchId)
      batchMessage = body.deduplicated
        ? `批次 ${payload.batchId} 已处理过（第 ${body.attempts} 次尝试），未重复生成审阅记录。`
        : `批次已并入 ${body.newRevision}：自动合并 ${body.appliedSummaries.length} 项${body.conflicts.length ? `，${body.conflicts.length} 个字段留待裁决` : ''}。`
      await invalidateAll()
    } catch {
      reviewOutbox.keepFailed(payload, '网络异常：写入未完成')
      batchMessage = '网络异常：整批与基线已保留在失败队列，可重试。'
    } finally {
      submitting = false
    }
  }
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div>
      <p class="eyebrow">REFORM REVIEW / 改革审阅</p>
      <h1>并行修订合并与逐项审阅</h1>
      <p class="muted">处理时绑定修订版本；提交时三方合并，仅双方都改过的字段留待裁决。</p>
    </div>
    <div class="role-switch">
      <label>当前身份
        <select bind:value={$roleStore}>
          <option>课程负责人</option>
          <option>院系审阅人</option>
        </select>
      </label>
      <label>姓名<input bind:value={$actorStore} /></label>
    </div>
  </div>

  {#if staleBase}
    <div class="notice warn">处理基线 {$reviewOutbox.baseRevision} 已是旧版（只读），当前系统版本为 {data.revision}。提交时将三方合并：未冲突的意见、证据和权重自动并入，双方均修改的字段留待裁决。</div>
  {/if}
  {#if data.mergePending > 0}
    <div class="notice info">合并进行中：{data.mergePending} 个字段待裁决。合并完成前旧版本保持只读；覆盖矩阵与课程地图导出指向实际并入版本 {data.revision}。</div>
  {/if}
  {#if batchMessage}
    <div class="notice info">{batchMessage}</div>
  {/if}
  {#if formMessage}
    <div class="notice error">{formMessage}</div>
  {/if}
  {#if formErrors}
    <div class="notice error">表单未通过校验：{Object.values(formErrors).flat().join('；')}</div>
  {/if}
  {#if formConflicts}
    <div class="notice error">
      <strong>仅以下冲突字段被拒绝（其余字段已并入）：</strong>
      <ul>
        {#each formConflicts as field}
          <li>{field.key}：基线「{short(field.base, 18)}」/ 系统「{short(field.current, 18)}」/ 提交「{short(field.incoming, 18)}」</li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if formSuccess}
    <div class="notice success">修订 {formSuccess.itemId} 已提交并入 {formSuccess.newRevision}{formSuccess.deduplicated ? '（重复提交已幂等去重）' : ''}。</div>
  {/if}
  {#if formResolved}
    <div class="notice success">冲突 {formResolved.key} 已裁决（{formResolved.resolution}），剩余待裁决 {formResolved.mergePending} 项。</div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head">
        <h3>审阅队列</h3>
        <div class="queue-actions">
          <span class="muted">当前版本 {data.revision} · {pendingItems.length} 项待处理</span>
          <button class="btn-secondary" disabled={pendingItems.length === 0} onclick={stageAllApprove}>暂存全部附议</button>
          <button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button>
        </div>
      </div>
      <div class="review-list">
        {#each data.reviewItems as item}
          {@const stagedStatus = stagedOp(item.id, 'review.status')}
          {@const stagedEvidence = stagedOp(item.id, 'review.evidence')}
          <article>
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {nodeLabel(item.courseId)}</strong>
                <span class:approved={item.status === '已附议'} class:returned={item.status === '已退回'}>{item.status}</span>
              </div>
              <p>{item.evidence}</p>
              <small>对应 {nodeLabel(item.requirementId)} · {item.submitter} 提交</small>
              {#if stagedStatus}
                <div class="staged-chip">已暂存：{stagedStatus.value}（批次 {$reviewOutbox.batchId} · 基线 {$reviewOutbox.baseRevision}）</div>
              {/if}
              {#if item.status === '待审阅'}
                <div class="review-actions">
                  <input bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见" />
                  <button class="btn-primary" onclick={() => stageReview(item.id, '已附议')}>附议</button>
                  <button class="btn-danger" onclick={() => stageReview(item.id, '已退回')}>退回补充</button>
                </div>
                {#if $roleStore === '课程负责人'}
                  <details class="evidence-edit">
                    <summary>离线修改证据（课程负责人）</summary>
                    <textarea
                      rows="3"
                      value={evidenceDrafts[item.id] ?? item.evidence}
                      oninput={(event) => (evidenceDrafts[item.id] = event.currentTarget.value)}
                    ></textarea>
                    <div>
                      <button class="btn-secondary" onclick={() => stageEvidence(item.id, item.evidence)}>暂存证据修改</button>
                      {#if stagedEvidence}<small>已暂存新证据：{short(stagedEvidence.value, 30)}</small>{/if}
                    </div>
                  </details>
                {/if}
              {:else}
                <div class:returned={item.status === '已退回'} class="decision">审阅意见：{item.comment}</div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="side-stack">
      <section class="panel">
        <div class="panel-head"><h3>暂存批次</h3><span class="muted">基线 {$reviewOutbox.baseRevision ?? data.revision}</span></div>
        <div class="batch-body">
          {#if $reviewOutbox.staged.length === 0}
            <p class="muted">暂无暂存修改。附议/退回、证据与权重修改会先暂存，并绑定处理时的修订版本。</p>
          {:else}
            <ul class="op-list">
              {#each $reviewOutbox.staged as op, index}
                <li>
                  <span>{opLabel(op)}：{short(opValue(op), 24)}</span>
                  <button class="link" onclick={() => reviewOutbox.unstage(index)}>移除</button>
                </li>
              {/each}
            </ul>
            <label class="simulate"><input type="checkbox" bind:checked={simulateFailure} /> 模拟写入失败（演示失败后保留整批与基线再重试）</label>
            <div class="batch-actions">
              <button class="btn-primary" disabled={submitting} onclick={() => submitBatch(buildPayload(), false)}>
                {submitting ? '提交中…' : `提交批次（${$reviewOutbox.staged.length} 项）`}
              </button>
              <button class="btn-secondary" onclick={() => reviewOutbox.clearStaged()}>清空暂存</button>
            </div>
          {/if}
          {#if $reviewOutbox.failed.length > 0}
            <div class="failed-list">
              <strong>失败批次（整批与基线已保留）</strong>
              {#each $reviewOutbox.failed as failed}
                <article>
                  <small>{failed.payload.batchId} · 基线 {failed.payload.baseRevision} · {failed.payload.ops.length} 项修改 · {failed.error}</small>
                  <div>
                    <button class="btn-primary" disabled={submitting} onclick={() => submitBatch(failed.payload, true)}>重试（不重复生成审阅记录）</button>
                    <button class="btn-secondary" onclick={() => reviewOutbox.dropFailed(failed.payload.batchId)}>放弃</button>
                  </div>
                </article>
              {/each}
            </div>
          {/if}
          {#if data.batches.length > 0}
            <div class="batch-log">
              <strong>服务端批次记录</strong>
              {#each [...data.batches].reverse().slice(0, 5) as batch}
                <small>{batch.batchId} · 基线 {batch.baseRevision} · {batch.status} · 第 {batch.attempts} 次尝试{batch.resultRevision ? ` → ${batch.resultRevision}` : ''}</small>
              {/each}
            </div>
          {/if}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>待裁决字段</h3><span class="muted">{pendingConflicts.length} 项 · 仅课程负责人可裁决</span></div>
        <div class="conflict-list">
          {#each pendingConflicts as conflict}
            <article>
              <strong>{opLabel(conflict.op)}</strong>
              <div class="conflict-values">
                <div><small>基线版本</small><p>{conflict.baseValue || '（空）'}</p></div>
                <div><small>系统当前</small><p>{conflict.currentValue}</p></div>
                <div><small>提交方（{conflict.author}）</small><p>{conflict.incomingValue}</p></div>
              </div>
              <form method="POST" action="?/resolveConflict" use:enhance>
                <input type="hidden" name="key" value={conflict.key} />
                <input type="hidden" name="role" value={$roleStore} />
                <input type="hidden" name="actor" value={$actorStore} />
                <button class="btn-primary" name="choice" value="incoming" disabled={$roleStore !== '课程负责人'}>采用提交方</button>
                <button class="btn-secondary" name="choice" value="current" disabled={$roleStore !== '课程负责人'}>保留系统方</button>
              </form>
              {#if $roleStore !== '课程负责人'}<small class="muted">院系审阅人不能越权裁决，需课程负责人处理。</small>{/if}
            </article>
          {:else}
            <p class="muted">没有待裁决的冲突字段。</p>
          {/each}
          {#if resolvedConflicts.length > 0}
            <div class="resolved-list">
              <strong>已裁决</strong>
              {#each resolvedConflicts as conflict}
                <small>{opLabel(conflict.op)} → {conflict.resolution}（{conflict.resolvedBy}）</small>
              {/each}
            </div>
          {/if}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>支撑权重调整</h3><span class="muted">{$roleStore === '课程负责人' ? '暂存后随批次合并' : '仅课程负责人可调整'}</span></div>
        <div class="weight-list">
          {#each supportMappings as mapping}
            {@const stagedWeight = $reviewOutbox.staged.find((entry): entry is Extract<FieldOp, { op: 'mapping.weight' }> => entry.op === 'mapping.weight' && entry.mappingId === mapping.id)}
            <div class="weight-row">
              <span>{nodeLabel(mapping.source)} → {nodeLabel(mapping.target)}</span>
              <small>当前 {Math.round(mapping.weight * 100)}%{stagedWeight ? ` → 暂存 ${Math.round(stagedWeight.value * 100)}%` : ''}</small>
              {#if $roleStore === '课程负责人'}
                <div class="weight-edit">
                  <input type="number" min="0" max="1" step="0.1" bind:value={weightDrafts[mapping.id]} placeholder={String(mapping.weight)} />
                  <button class="btn-secondary" onclick={() => stageWeight(mapping.id)}>暂存权重</button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>提交课程修订</h3><span class="muted">绑定基线 {data.revision}</span></div>
        <form
          method="POST"
          action="?/submitRevision"
          use:enhance={() => {
            return async ({ update }) => {
              await update()
              clientToken = newClientToken()
            }
          }}
        >
          <input type="hidden" name="baseRevision" value={data.revision} />
          <input type="hidden" name="clientToken" value={clientToken} />
          <input type="hidden" name="role" value={$roleStore} />
          <label>课程<select name="courseId">{#each courses as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
          <label>毕业要求<select name="requirementId">{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
          <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据"></textarea></label>
          <label>修订说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据"></textarea></label>
          <label>支撑权重（可选）<input name="weight" type="number" min="0" max="1" step="0.1" placeholder="留空则不调整" /></label>
          <label>提交人<input name="submitter" value={$actorStore} /></label>
          <button class="btn-primary" type="submit">提交院系审阅</button>
          <small class="muted">若提交期间基线已变化，仅冲突字段被拒绝并留待裁决，其余字段正常并入。</small>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>版本线</h3><span class="muted">旧版只读</span></div>
        <div class="revision-list">
          {#each [...data.revisions].reverse() as revision}
            <article class:current={revision.current}>
              <strong>{revision.id}</strong>
              <span>{revision.cause}</span>
              <small>{revision.current ? '当前版本' : `只读 · 已并入 ${revision.mergedInto}`}</small>
            </article>
          {/each}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h3>合并与裁决记录</h3><span class="muted">重试不重复生成</span></div>
        <div class="audit-list">
          {#each data.audit as entry}
            <article>
              <small>{entry.id} · {entry.revision} · 批次 {entry.batchId}</small>
              <p>{entry.summary}</p>
              <small>{entry.actor}（{entry.role}）· {entry.at.slice(11, 19)}</small>
            </article>
          {:else}
            <p class="muted">暂无合并记录。</p>
          {/each}
        </div>
      </section>
    </aside>
  </div>
</section>

<style>
  .role-switch { display: flex; gap: 10px; align-items: end; }
  .role-switch label { min-width: 130px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .notice.warn { border-color: #cd813a; color: #8a5a22; background: #fff6e9; }
  .notice.info { border-color: #4a7f9e; color: #2f5a74; background: #ecf4f9; }
  .notice.success { border-color: #3f8869; }
  .notice ul { margin: 8px 0 0; padding-left: 18px; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 400px; gap: 14px; align-items: start; }
  .side-stack { display: grid; gap: 14px; }
  .queue-actions { display: flex; gap: 8px; align-items: center; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .review-main small { color: #839096; }
  .staged-chip { margin-top: 8px; padding: 6px 8px; border-radius: 5px; color: #2f5a74; background: #ecf4f9; font-size: 11px; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; }
  .review-actions input { flex: 1; }
  .evidence-edit { margin-top: 10px; padding: 10px; border: 1px dashed #c4d0d1; border-radius: 7px; }
  .evidence-edit summary { color: #325b61; font-size: 12px; cursor: pointer; }
  .evidence-edit textarea { margin-top: 8px; }
  .evidence-edit > div { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  .batch-body { display: grid; gap: 12px; padding: 14px 16px 16px; }
  .batch-body > p { margin: 0; font-size: 12px; }
  .op-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .op-list li { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid #e0e6e6; border-radius: 6px; font-size: 11px; }
  .link { border: 0; color: #a94431; background: none; cursor: pointer; font-size: 11px; }
  .simulate { display: flex; gap: 7px; align-items: center; font-weight: 400; }
  .simulate input { width: auto; }
  .batch-actions { display: flex; gap: 8px; }
  .failed-list { display: grid; gap: 8px; padding: 10px; border-left: 3px solid #bd4d35; background: #fff4ef; }
  .failed-list strong, .batch-log strong { font-size: 11px; }
  .failed-list article { display: grid; gap: 7px; }
  .failed-list article > div { display: flex; gap: 7px; }
  .failed-list small, .batch-log small { display: block; color: #7a6a62; font-size: 10px; }
  .batch-log { display: grid; gap: 5px; padding-top: 10px; border-top: 1px solid #e7ebeb; }
  .batch-log strong { color: #596a71; }
  .batch-log small { color: #839096; }
  .conflict-list { display: grid; gap: 10px; padding: 14px 16px 16px; }
  .conflict-list > p { margin: 0; font-size: 12px; }
  .conflict-list article { padding: 10px; border: 1px solid #ecd9c8; border-radius: 7px; background: #fffcf8; }
  .conflict-list article > strong { font-size: 12px; }
  .conflict-values { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin: 9px 0; }
  .conflict-values small { color: #98a4a9; font-size: 9px; }
  .conflict-values p { margin: 3px 0 0; color: #5f6e74; font-size: 10px; word-break: break-all; }
  .conflict-list form { display: flex; gap: 7px; }
  .resolved-list { display: grid; gap: 5px; padding-top: 10px; border-top: 1px solid #e7ebeb; }
  .resolved-list strong { font-size: 11px; color: #596a71; }
  .resolved-list small { color: #839096; font-size: 10px; }
  .weight-list { display: grid; gap: 8px; padding: 14px 16px 16px; }
  .weight-row { display: grid; gap: 6px; padding: 9px 10px; border: 1px solid #e0e6e6; border-radius: 7px; }
  .weight-row > span { font-size: 11px; font-weight: 700; }
  .weight-row > small { color: #79868c; font-size: 10px; }
  .weight-edit { display: flex; gap: 7px; }
  .weight-edit input { max-width: 90px; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button[type='submit'] { margin-top: 3px; }
  .revision-list { display: grid; gap: 7px; padding: 14px 16px 16px; }
  .revision-list article { display: grid; gap: 3px; padding: 9px 10px; border: 1px solid #e0e6e6; border-radius: 7px; }
  .revision-list article.current { border-color: #3f8869; background: #f2faf6; }
  .revision-list strong { font-size: 12px; }
  .revision-list span { color: #5f6e74; font-size: 10px; }
  .revision-list small { color: #8b979c; font-size: 9px; }
  .audit-list { display: grid; gap: 8px; padding: 14px 16px 16px; max-height: 300px; overflow: auto; }
  .audit-list article { padding: 8px 10px; border-left: 3px solid #377c7b; background: #f6f8f7; }
  .audit-list p { margin: 4px 0; color: #4d5f66; font-size: 11px; }
  .audit-list small { color: #8b979c; font-size: 9px; }
  .audit-list > p { margin: 0; font-size: 12px; }
  @media (max-width: 1100px) { .review-layout { grid-template-columns: 1fr; } }
</style>
