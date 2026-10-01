'use strict';
// 跨草案条款移植 端到端冒烟测试。
// 用法：先启动服务，再 E2E_BASE=http://127.0.0.1:PORT node test/port.e2e.js
const base = process.env.E2E_BASE || 'http://127.0.0.1:3999';

let pass = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  pass++;
  console.log('  ✓ ' + msg);
}

async function call(method, p, body, expected) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (expected && res.status !== expected) {
    console.error(`✗ ${method} ${p} expected ${expected}, got ${res.status}:`, JSON.stringify(data));
    process.exit(1);
  }
  return { status: res.status, data };
}
const api = (m, p, b) => call(m, p, b).then((r) => r.data);
const orderOf = (det) => det.projected ? det.projected.order.map ? det.projected.order : det.projected.clauses.map((c) => c.key) : null;

async function main() {
  await call('POST', '/api/initialize', {
    charter_title: '移植测试章程',
    clauses: [
      { key: 'A', title: '总则', body: 'AAA' },
      { key: 'B', title: '会员', body: 'BBB' },
      { key: 'C', title: '附则', body: 'CCC' },
    ],
    refs: [{ source: 'A', target: 'B', label: '见' }],
  }, 201);

  // 两个并行草案：来源 S 与 目标 T（同基线 v1）
  const s = await api('POST', '/api/drafts', { name: '来源草案' });
  const t = await api('POST', '/api/drafts', { name: '目标草案' });
  const SID = s.id;
  const TID = t.id;
  ok(s.revision === 1 && t.revision === 1, '两个新草案修订号均为 1');

  // ------------------------------------------------------------------
  // 来源草案改动：改 A 正文、加 A→C 引用、新增 D（D→C）、移动（稍后）
  // ------------------------------------------------------------------
  await call('PUT', `/api/drafts/${SID}/clauses/A`, { title: '总则', body: 'AAA-来源改' }, 200);
  await call('POST', `/api/drafts/${SID}/refs`, { source: 'A', target: 'C', label: '依据' }, 200);
  await call('POST', `/api/drafts/${SID}/clauses`, { key: 'D', title: '经费', body: 'DDD' }, 200);
  await call('POST', `/api/drafts/${SID}/refs`, { source: 'D', target: 'C', label: '' }, 200);
  const srcAfter = await api('GET', `/api/drafts/${SID}`);
  const SREV = srcAfter.revision;
  ok(SREV === 5, `来源草案 4 次改动后修订号 5（实际 ${SREV}）`);

  // ------------------------------------------------------------------
  // port-sources：目标可见来源草案及其改动标识
  // ------------------------------------------------------------------
  let ps = await call('GET', `/api/drafts/${TID}/port-sources`, null, 200);
  const found = ps.data.sources.find((x) => x.id === SID);
  ok(!!found, '目标草案的可移植来源列表包含来源草案');
  ok(found.changed_keys.includes('A') && found.changed_keys.includes('D'), '来源改动标识包含 A、D');
  ok(found.revision === SREV, '来源列表带当前修订号');
  // 反向：来源视角下列表里也应包含目标（目标暂无改动也可作为来源候选，changed 为空）
  ps = await api('GET', `/api/drafts/${SID}/port-sources`);
  ok(ps.sources.some((x) => x.id === TID), '来源草案视角也能看到目标草案');

  // ------------------------------------------------------------------
  // 预演：选择 A 与 D，目标未动 -> 全部可应用
  // ------------------------------------------------------------------
  let pv = await call('POST', `/api/drafts/${TID}/port-preview`,
    { source_draft_id: SID, clause_keys: ['A', 'D'] }, 200);
  ok(pv.data.applicable === true, '预演 applicable=true（无冲突无新悬空）');
  ok(pv.data.source_revision === SREV && pv.data.target_revision === 1, '预演回显两份草案修订号');
  const proj = pv.data.projected;
  ok(proj.clauses.find((c) => c.key === 'A').body === 'AAA-来源改', '预演：A 正文为来源版本');
  ok(proj.clauses.some((c) => c.key === 'D'), '预演：D 出现在投影中');
  ok(proj.order.join(',') === 'A,B,C,D', '预演：D 追加在末尾');
  ok(proj.refs.some((r) => r.source === 'A' && r.target === 'C' && r.label === '依据'), '预演：A→C 引用被移植');
  ok(proj.refs.some((r) => r.source === 'D' && r.target === 'C'), '预演：D→C 引用随 D 移植');
  // 目标尚未变化（预演不写库）
  let tdet = await api('GET', `/api/drafts/${TID}`);
  ok(tdet.revision === 1 && tdet.clauses.length === 3, '预演不修改目标草案（修订号仍 1、仍 3 条）');
  // 来源也没被碰
  ok((await api('GET', `/api/drafts/${SID}`)).revision === SREV, '预演不修改来源草案');

  // diff 字段
  ok(pv.data.diff.added.includes('D'), '预演差异：added 含 D');
  ok(pv.data.diff.changed.some((c) => c.key === 'A'), '预演差异：changed 含 A');
  ok(pv.data.diff.refs_added.length >= 2, '预演差异：列出新增引用');

  // ------------------------------------------------------------------
  // 冲突：先让目标对 A 做不同改动，再预演 -> 逐条冲突
  // ------------------------------------------------------------------
  await call('PUT', `/api/drafts/${TID}/clauses/A`, { title: '总则', body: 'AAA-目标改' }, 200);
  const tAfterOwnEdit = await api('GET', `/api/drafts/${TID}`);
  const TREV2 = tAfterOwnEdit.revision;
  pv = await call('POST', `/api/drafts/${TID}/port-preview`,
    { source_draft_id: SID, clause_keys: ['A', 'D'] }, 200);
  ok(pv.data.applicable === false, '有冲突时预演 applicable=false（HTTP 仍 200，纯预演）');
  const ca = pv.data.conflicts.find((c) => c.key === 'A');
  ok(!!ca && ca.kind === 'modify-modify' && ca.facets.includes('body'), 'A 报 modify-modify / body 冲突');
  const itemA = pv.data.items.find((i) => i.key === 'A');
  ok(itemA.status === 'conflict' && itemA.conflict_facets.includes('body'), 'items 逐条说明 A 的冲突面');
  const itemD = pv.data.items.find((i) => i.key === 'D');
  ok(itemD.status === 'apply', '同一预演中无冲突的 D 标记为 apply');
  // 冲突时确认 -> 409 PORT_CONFLICT，目标保持自己的正文
  let cf = await call('POST', `/api/drafts/${TID}/port-confirm`,
    { source_draft_id: SID, clause_keys: ['A', 'D'], source_revision: SREV, target_revision: TREV2 }, 409);
  ok(cf.data.error === 'PORT_CONFLICT', '冲突确认返回 PORT_CONFLICT');
  tdet = await api('GET', `/api/drafts/${TID}`);
  ok(tdet.clauses.find((c) => c.key === 'A').body === 'AAA-目标改' && tdet.clauses.length === 3,
    '冲突拒绝后目标原样（A 仍是目标改法、无 D）');

  // 只选无冲突的 D：预演可应用并确认成功
  pv = await api('POST', `/api/drafts/${TID}/port-preview`, { source_draft_id: SID, clause_keys: ['D'] });
  ok(pv.applicable === true && pv.items[0].status === 'apply', '只选 D：可应用');
  const okRev = await call('POST', `/api/drafts/${TID}/port-confirm`,
    { source_draft_id: SID, clause_keys: ['D'], source_revision: pv.source_revision, target_revision: pv.target_revision }, 200);
  ok(okRev.data.ok === true && okRev.data.applied === true, '确认移植 D 成功');
  ok(okRev.data.operation_summary.includes('移植') && okRev.data.history_seq >= 2, '返回操作摘要与历史序号');
  tdet = await api('GET', `/api/drafts/${TID}`);
  ok(tdet.clauses.length === 4 && tdet.clauses.some((c) => c.key === 'D'), '目标现有 4 条且包含 D');
  ok(tdet.refs.some((r) => r.source === 'D' && r.target === 'C'), 'D→C 引用已进入目标');
  ok(tdet.clauses.find((c) => c.key === 'A').body === 'AAA-目标改', '未移植的 A 保持目标自身改动');
  const TREV3 = tdet.revision;
  ok(TREV3 === TREV2 + 1, '移植使目标修订号 +1');
  // 来源完全不变
  const sdet = await api('GET', `/api/drafts/${SID}`);
  ok(sdet.revision === SREV, '来源草案在移植后保持原样');

  // ------------------------------------------------------------------
  // 历史可撤销：移植是目标操作历史中的一条 clause-port 记录
  // ------------------------------------------------------------------
  let h = await api('GET', `/api/drafts/${TID}/history`);
  const portOp = h.operations.find((o) => o.kind === 'clause-port');
  ok(!!portOp, '目标历史包含 clause-port 操作');
  ok(portOp.detail.applied_keys.includes('D') && portOp.detail.source_draft_id === SID,
    '移植操作 detail 记录来源草案与已应用标识');
  const undo = await call('POST', `/api/drafts/${TID}/undo`, { revision: h.revision }, 200);
  ok(undo.data.applied_kind === 'clause-port', '撤销的正是移植操作');
  tdet = await api('GET', `/api/drafts/${TID}`);
  ok(tdet.clauses.length === 3 && !tdet.clauses.some((c) => c.key === 'D'), '撤销移植：D 及其引用被完整还原移除');
  // 重做恢复
  h = await api('GET', `/api/drafts/${TID}/history`);
  await call('POST', `/api/drafts/${TID}/redo`, { revision: h.revision }, 200);
  tdet = await api('GET', `/api/drafts/${TID}`);
  ok(tdet.clauses.some((c) => c.key === 'D'), '重做移植：D 回到目标');

  // ------------------------------------------------------------------
  // 旧确认拒绝：修订号不匹配
  // ------------------------------------------------------------------
  h = await api('GET', `/api/drafts/${TID}/history`);
  // 目标当前修订号记为 cur；用过期的 target_revision 确认 A
  pv = await api('POST', `/api/drafts/${TID}/port-preview`, { source_draft_id: SID, clause_keys: ['A'] });
  // 预览后先改动来源，再用旧 source_revision 确认
  await call('PUT', `/api/drafts/${SID}/clauses/B`, { title: '会员', body: 'BBB-来源再改' }, 200);
  let stale = await call('POST', `/api/drafts/${TID}/port-confirm`,
    { source_draft_id: SID, clause_keys: ['A'], source_revision: pv.source_revision, target_revision: pv.target_revision }, 409);
  ok(stale.data.error === 'STALE_DRAFT_REVISION' && stale.data.stale.some((x) => x.side === 'source'),
    '预演后来源变化：旧确认 409 STALE_DRAFT_REVISION（并列明 side=source 与当前修订号）');
  // 目标修订号过期
  const curT = (await api('GET', `/api/drafts/${TID}`)).revision;
  stale = await call('POST', `/api/drafts/${TID}/port-confirm`,
    { source_draft_id: SID, clause_keys: ['B'], source_revision: 999, target_revision: curT + 5 }, 409);
  ok(stale.data.error === 'STALE_DRAFT_REVISION', '目标修订号过期同样拒绝');

  // ------------------------------------------------------------------
  // 新悬空整次拒绝：来源新增 E，D→E；只移植引用所在条款而不移植 E 不可能直接做到，
  // 改为：来源删除 B 但保留 A→B 悬空，目标仍有 B -> 移植删除会产生 A→B 悬空
  // ------------------------------------------------------------------
  // 建第三对干净草案便于构造
  const s2 = await api('POST', '/api/drafts', { name: '来源-删除' });
  const t2 = await api('POST', '/api/drafts', { name: '目标-悬空' });
  await call('DELETE', `/api/drafts/${s2.id}/clauses/B`, null, 200); // 保留 A→B 悬空
  // 来源删除 B 后自身不可发布（有悬空），但移植预演照常
  pv = await api('POST', `/api/drafts/${t2.id}/port-preview`, { source_draft_id: s2.id, clause_keys: ['B'] });
  ok(pv.new_dangling.some((d) => d.source === 'A' && d.target === 'B'), '预演列出移植后新悬空 A→B');
  ok(pv.applicable === false, '存在新悬空时 applicable=false');
  const dg = await call('POST', `/api/drafts/${t2.id}/port-confirm`,
    { source_draft_id: s2.id, clause_keys: ['B'], source_revision: pv.source_revision, target_revision: pv.target_revision }, 409);
  ok(dg.data.error === 'PORT_DANGLING', '新悬空确认 -> 409 PORT_DANGLING，整次拒绝');
  tdet = await api('GET', `/api/drafts/${t2.id}`);
  ok(tdet.clauses.length === 3 && tdet.clauses.some((c) => c.key === 'B'), '拒绝后目标内容不变（B 仍在）');

  // ------------------------------------------------------------------
  // 已相同改动收敛：来源与目标做同样修改，预演 converged、确认无需移植
  // ------------------------------------------------------------------
  const s3 = await api('POST', '/api/drafts', { name: '来源-收敛' });
  const t3 = await api('POST', '/api/drafts', { name: '目标-收敛' });
  await call('PUT', `/api/drafts/${s3.id}/clauses/C`, { title: '附则', body: 'CCC-X' }, 200);
  await call('PUT', `/api/drafts/${t3.id}/clauses/C`, { title: '附则', body: 'CCC-X' }, 200);
  pv = await api('POST', `/api/drafts/${t3.id}/port-preview`, { source_draft_id: s3.id, clause_keys: ['C'] });
  ok(pv.items[0].status === 'converged' && pv.applied_keys.length === 0, '相同改动标记 converged、无应用面');
  ok(pv.applicable === true, '仅收敛时 applicable=true（无冲突无悬空）');
  const noop = await call('POST', `/api/drafts/${t3.id}/port-confirm`,
    { source_draft_id: s3.id, clause_keys: ['C'], source_revision: pv.source_revision, target_revision: pv.target_revision }, 400);
  ok(noop.data.error === 'NO_CHANGES_TO_APPLY', '全部收敛时确认 400 NO_CHANGES_TO_APPLY，目标不动');

  // ------------------------------------------------------------------
  // 基线不同 / 已发布 / 同草案 / 标识非法
  // ------------------------------------------------------------------
  // 先发布一个新版本（用来源-收敛之外的草案）。发布 s3：基线 v1 且仅有 C 改动
  const pub = await call('POST', `/api/drafts/${s3.id}/publish`, { note: 'v2' }, 201);
  ok(!!pub.data.version_id, '发布 v2 成功');
  // 基线仍为 v1 的草案与基线 v2 的草案之间不能移植
  const fromV2 = await api('POST', '/api/drafts', { name: '基于v2', baseline_id: pub.data.version_id });
  let bad = await call('POST', `/api/drafts/${t3.id}/port-preview`, { source_draft_id: fromV2.id, clause_keys: ['C'] }, 409);
  ok(bad.data.error === 'BASELINE_MISMATCH', '基线不同 -> 409 BASELINE_MISMATCH');
  // 已发布草案不能作为来源/目标
  bad = await call('POST', `/api/drafts/${t3.id}/port-preview`, { source_draft_id: s3.id, clause_keys: ['C'] }, 409);
  ok(bad.data.error === 'CLOSED', '已发布来源 -> 409 CLOSED');
  // 同草案
  bad = await call('POST', `/api/drafts/${t3.id}/port-preview`, { source_draft_id: t3.id, clause_keys: ['C'] }, 400);
  ok(bad.data.error === 'VALIDATION', '来源与目标相同 -> 400');
  // 来源未改动的标识 / 不存在标识
  bad = await call('POST', `/api/drafts/${t3.id}/port-preview`,
    { source_draft_id: s2.id, clause_keys: ['NOPE'] }, 400);
  ok(bad.data.error === 'VALIDATION' && bad.data.invalid.some((i) => i.reason === 'unknown-key'), '未知标识 -> 400 并附原因');
  // 空选择
  bad = await call('POST', `/api/drafts/${t3.id}/port-confirm`,
    { source_draft_id: s2.id, clause_keys: [] }, 400);
  ok(bad.data.error === 'VALIDATION', '空 clause_keys -> 400');
  // 缺少修订号
  bad = await call('POST', `/api/drafts/${t2.id}/port-confirm`,
    { source_draft_id: s2.id, clause_keys: ['B'] }, 400);
  ok(bad.data.error === 'VALIDATION', '确认缺少修订号 -> 400');

  // ------------------------------------------------------------------
  // 移植使目标旧发布预览凭据失效
  // ------------------------------------------------------------------
  const s4 = await api('POST', '/api/drafts', { name: '来源-凭据' });
  const t4 = await api('POST', '/api/drafts', { name: '目标-凭据' });
  await call('PUT', `/api/drafts/${s4.id}/clauses/A`, { title: '总则', body: 'AAA-S4' }, 200);
  // 目标先做一次发布预览取得凭据
  await call('PUT', `/api/drafts/${t4.id}/clauses/B`, { title: '会员', body: 'BBB-T4' }, 200);
  const prev = await call('POST', `/api/drafts/${t4.id}/preview`, { note: '预发' }, 200);
  ok(typeof prev.data.token === 'string', '目标取得发布预览凭据');
  // 把来源 A 的改动移植进目标 -> 目标变化
  pv = await api('POST', `/api/drafts/${t4.id}/port-preview`, { source_draft_id: s4.id, clause_keys: ['A'] });
  await call('POST', `/api/drafts/${t4.id}/port-confirm`,
    { source_draft_id: s4.id, clause_keys: ['A'], source_revision: pv.source_revision, target_revision: pv.target_revision }, 200);
  const oldTok = await call('POST', `/api/drafts/${t4.id}/publish`, { preview_token: prev.data.token }, 404);
  ok(oldTok.data.error === 'PREVIEW_TOKEN_NOT_FOUND', '移植后目标旧预览凭据失效（404）');

  console.log(`\n移植端到端 ${pass} 项检查全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
