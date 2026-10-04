<script lang="ts">
  import { curriculumStore } from '$lib/stores'
  import { revisionSchema } from '$lib/schema'
  import type { FieldChange } from '$lib/merge'

  let selectedIds = $state<string[]>([])
  let reviewComments = $state<Record<string, string>>({})
  let evidenceDrafts = $state<Record<string, string>>({})
  let adjudicateDrafts = $state<Record<string, string>>({})
  let simulateFailure = $state(false)
  let formResult = $state<{ success?: boolean; errors?: Record<string, string[]>; queued?: boolean } | null>(null)

  const pending = $derived($curriculumStore.reviewItems.filter((item) => item.status === '待审阅'))
  const courseNames = $derived($curriculumStore.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived($curriculumStore.nodes.filter((node) => node.type === '毕业要求'))
  const stale = $derived($curriculumStore.baseline !== $curriculumStore.revision)
  const canEdit = $derived(!$curriculumStore.offline && !stale)
  const isReviewer = $derived($curriculumStore.role === '审阅人')
  const conflicts = $derived($curriculumStore.conflicts.filter((c) => c.status === 'pending'))
  const failedBatches = $derived($curriculumStore.batches.filter((b) => b.status === 'failed'))
  const conflictBatches = $derived($curriculumStore.batches.filter((b) => b.status === 'conflict'))

  function review(item: (typeof $curriculumStore.reviewItems)[number], status: '已附议' | '已退回') {
    curriculumStore.decideReview(item.id, status, reviewComments[item.id] || (status === '已附议' ? '证据充分，同意纳入修订。' : '请补充可验证的评分记录。'))
  }

  function bulkApprove() {
    selectedIds.forEach((id) => {
      const item = $curriculumStore.reviewItems.find((entry) => entry.id === id)
      if (item) curriculumStore.decideReview(id, '已附议', '批量附议：证据链完整。')
    })
    selectedIds = []
  }

  function saveEvidence(itemId: string) {
    const v = evidenceDrafts[itemId]
    if (v && v.trim().length >= 12) {
      curriculumStore.queueEvidence(itemId, v.trim())
      evidenceDrafts[itemId] = ''
    }
  }

  async function submitRevision(event: Event) {
    event.preventDefault()
    const formEl = event.currentTarget as HTMLFormElement
    const data = Object.fromEntries(new FormData(formEl))
    const parsed = revisionSchema.safeParse(data)
    if (!parsed.success) {
      formResult = { errors: parsed.error.flatten().fieldErrors }
      return
    }
    if ($curriculumStore.offline) {
      curriculumStore.queueCreateReview(parsed.data)
      formResult = { success: true, queued: true }
    } else {
      await curriculumStore.mutate('createReview', parsed.data)
      formResult = { success: true }
    }
    formEl.reset()
  }

  function changeSummary(change: FieldChange): string {
    if (change.op === 'createReview') return `新增审阅记录 ${change.tempId}`
    const entity = change.entityType === 'mapping' ? '映射' : '审阅记录'
    return `${entity} ${change.entityId} · ${change.field}`
  }

  function adjudicate(conflictId: string, fallback: unknown) {
    const raw = adjudicateDrafts[conflictId]
    const value = raw === undefined || raw === '' ? fallback : raw
    void curriculumStore.adjudicate(conflictId, value)
  }
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">REFORM REVIEW / 改革审阅</p><h1>修订提交与并行审阅</h1><p class="muted">绑定处理时的修订版本，非冲突字段自动并入，冲突留待裁决。</p></div>
    <div class="actions">
      <button class="btn-secondary" disabled={selectedIds.length === 0 || !canEdit} onclick={bulkApprove}>批量附议 {selectedIds.length ? `(${selectedIds.length})` : ''}</button>
      <button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button>
    </div>
  </div>

  {#if formResult?.success}
    <div class="notice success">{formResult.queued ? '修订已加入离线批次，提交后并入。' : '修订已提交，进入院系审阅队列。'}</div>
  {:else if formResult?.errors}
    <div class="notice error">表单未通过校验：{Object.values(formResult.errors).flat().join('；')}</div>
  {/if}
  {#if $curriculumStore.lastNotice}<div class="notice success">{$curriculumStore.lastNotice}</div>{/if}
  {#if $curriculumStore.lastError}<div class="notice error">{$curriculumStore.lastError}</div>{/if}

  {#if stale}
    <div class="notice error">旧版只读：当前工作副本绑定基线 {$curriculumStore.baseline}，系统已推进到 {$curriculumStore.revision}。请先在下方合并批次，完成前不可直接写入。</div>
  {/if}
  {#if $curriculumStore.offline}
    <div class="notice offline">离线编辑中：改动仅排队不写入。绑定基线 {$curriculumStore.baseline}，共 {$curriculumStore.pendingChanges.length} 项待并入。</div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head">
        <h3>审阅队列</h3>
        <span class="muted">{pending.length} 项待处理</span>
      </div>
      <div class="review-list">
        {#each $curriculumStore.reviewItems as item}
          <article class:selected={selectedIds.includes(item.id)}>
            <div class="select"><input type="checkbox" checked={selectedIds.includes(item.id)} onchange={(event) => selectedIds = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id)} /></div>
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {courseNames.find((node) => node.id === item.courseId)?.label.split('\n')[0]}</strong>
                <span class:approved={item.status === '已附议'} class:returned={item.status === '已退回'}>{item.status}</span>
              </div>
              <p>{item.evidence}</p>
              <small>对应 {requirements.find((node) => node.id === item.requirementId)?.label.split('\n')[0]} · {item.submitter} 提交</small>
              {#if item.status === '待审阅'}
                {#if canEdit}
                  <div class="review-actions">
                    <input bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见" />
                    <button class="btn-primary" onclick={() => review(item, '已附议')}>附议</button>
                    <button class="btn-danger" onclick={() => review(item, '已退回')}>退回补充</button>
                  </div>
                {:else if $curriculumStore.offline}
                  <div class="review-actions">
                    <input bind:value={evidenceDrafts[item.id]} placeholder="离线修改证据说明（≥12 字符）" />
                    <button class="btn-secondary" onclick={() => saveEvidence(item.id)}>加入离线批次</button>
                  </div>
                {:else}
                  <div class="decision returned">旧版只读，合并完成前不可处理意见。</div>
                {/if}
              {:else}
                <div class:returned={item.status === '已退回'} class="decision">审阅意见：{item.comment}</div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>提交课程修订</h3><span class="muted">服务端校验 · 绑定版本</span></div>
      <form onsubmit={submitRevision}>
        <label>课程<select name="courseId">{#each courseNames as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
        <label>毕业要求<select name="requirementId">{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
        <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据"></textarea></label>
        <label>修订说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据"></textarea></label>
        <label>提交人<input name="submitter" placeholder="课程负责人姓名" /></label>
        <button class="btn-primary" type="submit">{$curriculumStore.offline ? '加入离线批次' : '提交院系审阅'}</button>
      </form>
      <div class="version-compare">
        <strong>版本轨迹</strong>
        {#each $curriculumStore.versions.slice(-4).reverse() as v}
          <div><span>{v.revision} · {v.note}</span><b>{v.mergedAt.slice(5, 16)}</b></div>
        {/each}
      </div>
    </aside>
  </div>

  {#if $curriculumStore.offline || $curriculumStore.pendingChanges.length > 0}
    <section class="panel batch-panel">
      <div class="panel-head">
        <h3>离线批次</h3>
        <span class="muted">基线 {$curriculumStore.baseline} · {$curriculumStore.pendingChanges.length} 项待并入</span>
      </div>
      {#if $curriculumStore.pendingChanges.length === 0}
        <p class="muted" style="padding:0 16px 16px">暂无排队改动。可在上方离线修改证据，或到映射图谱调整权重。</p>
      {:else}
        <ul class="batch-list">
          {#each $curriculumStore.pendingChanges as change, i}
            <li>
              <span>{changeSummary(change)}</span>
              {#if change.op !== 'createReview'}<small>{String(change.baseValue)} → {String(change.newValue)}</small>{/if}
              <button class="btn-ghost" onclick={() => curriculumStore.removePendingChange(i)}>移除</button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="batch-actions">
        <label class="fail-toggle"><input type="checkbox" bind:checked={simulateFailure} />模拟写入失败（验证整批保留与重试）</label>
        <button class="btn-primary" disabled={$curriculumStore.pendingChanges.length === 0} onclick={() => curriculumStore.submitBatch(simulateFailure)}>提交批次合并</button>
      </div>
    </section>
  {/if}

  {#if conflicts.length > 0}
    <section class="panel batch-panel">
      <div class="panel-head"><h3>冲突裁决</h3><span class="muted">{conflicts.length} 项两边都改过的字段待裁决</span></div>
      {#if isReviewer}<div class="notice error" style="margin:0 16px 12px">院系审阅人无权裁决冲突，请联系课程负责人处理。</div>{/if}
      <ul class="conflict-list">
        {#each conflicts as c}
          <li>
            <div class="conflict-head"><strong>{c.entityId} · {c.label}</strong><span class="muted">批次 {c.batchId}</span></div>
            <div class="conflict-vals">
              <div><em>基线</em><code>{String(c.baseValue)}</code></div>
              <div><em>离线</em><code>{String(c.oursValue)}</code></div>
              <div><em>系统</em><code>{String(c.theirsValue)}</code></div>
            </div>
            {#if !isReviewer}
              <div class="conflict-actions">
                <input bind:value={adjudicateDrafts[c.id]} placeholder="裁决值（留空采用离线值）" />
                <button class="btn-secondary" onclick={() => adjudicate(c.id, c.oursValue)}>采用离线值</button>
                <button class="btn-secondary" onclick={() => adjudicate(c.id, c.theirsValue)}>采用系统值</button>
                <button class="btn-primary" onclick={() => adjudicate(c.id, adjudicateDrafts[c.id] ?? c.oursValue)}>裁决并入</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if failedBatches.length > 0 || conflictBatches.length > 0}
    <section class="panel batch-panel">
      <div class="panel-head"><h3>批次记录</h3><span class="muted">失败保留整批与基线，可重试且不重复生成审阅记录</span></div>
      <ul class="batch-list">
        {#each [...failedBatches, ...conflictBatches] as batch}
          <li>
            <span>{batch.id} · 基线 {batch.baseline} · 尝试 {batch.attempts} 次</span>
            <span class:failed={batch.status === 'failed'} class:conflict={batch.status === 'conflict'}>{batch.status === 'failed' ? '写入失败' : '部分冲突'}</span>
            {#if batch.status === 'failed'}
              <button class="btn-secondary" onclick={() => curriculumStore.retryBatch(batch.id, simulateFailure)}>重试</button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .notice.offline { border-color: #cd813a; color: #8a5a2b; background: #fff6e9; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-list article.selected { background: #f4f8f7; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .review-main small { color: #839096; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; }
  .review-actions input { flex: 1; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button { margin-top: 3px; }
  .version-compare { margin: 0 16px 16px; padding: 12px; border: 1px solid #dbe3e3; border-radius: 8px; background: #f6f8f7; }
  .version-compare strong { display: block; margin-bottom: 9px; font-size: 12px; }
  .version-compare div { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; color: #66757b; font-size: 10px; }
  .version-compare b { color: #2e7359; }
  .batch-panel { margin-top: 14px; }
  .batch-list, .conflict-list { list-style: none; margin: 0; padding: 0 16px 16px; }
  .batch-list li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #edf0f0; font-size: 12px; }
  .batch-list li span:first-child { flex: 1; color: #33464c; }
  .batch-list small { color: #839096; }
  .batch-list .failed { color: #a94331; }
  .batch-list .conflict { color: #9b5a25; }
  .batch-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px 16px; }
  .fail-toggle { display: flex; align-items: center; gap: 6px; margin: 0; font-weight: 400; font-size: 11px; color: #6f7d83; }
  .fail-toggle input { width: auto; }
  .btn-ghost { padding: 4px 8px; border: 1px solid #dbe3e3; border-radius: 6px; color: #6f7d83; background: transparent; font-size: 11px; cursor: pointer; }
  .conflict-list li { padding: 12px 0; border-bottom: 1px solid #edf0f0; }
  .conflict-head { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; }
  .conflict-vals { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin-bottom: 8px; }
  .conflict-vals > div { padding: 8px; border: 1px solid #e0e6e6; border-radius: 6px; background: #f8fafa; }
  .conflict-vals em { display: block; color: #839096; font-size: 10px; font-style: normal; }
  .conflict-vals code { display: block; margin-top: 4px; color: #25434b; font-size: 12px; word-break: break-all; }
  .conflict-actions { display: flex; gap: 7px; }
  .conflict-actions input { flex: 1; }
  @media (max-width: 1050px) { .review-layout { grid-template-columns: 1fr; } }
</style>
