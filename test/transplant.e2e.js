'use strict';
// 草案间移植（选择条款改动 / 预演 / 确认）端到端冒烟测试。
// 用法：先启动服务，再 E2E_BASE=http://127.0.0.1:PORT node test/transplant.e2e.js
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
  return data;
}

const orderOf = (det) => det.clauses.map((c) => c.key).join(',');

async function newDraft(name, baselineId) {
  const d = await call('POST', '/api/drafts', baselineId ? { name, baseline_id: baselineId } : { name }, 201);
  return d.id;
}

async function main() {
  // v1：A B C，引用 B->A
  await call('POST', '/api/initialize', {
    charter_title: '移植测试章程',
    clauses: [
      { key: 'A', title: '总则', body: 'AAA' },
      { key: 'B', title: '会员', body: 'BBB' },
      { key: 'C', title: '附则', body: 'CCC' },
    ],
    refs: [{ source: 'B', target: 'A', label: '参见' }],
  }, 201);

  // ------------------------------------------------------------------
  // 来源草案 ds（基线 v1）：改 A 正文、新增 D（含 D->A）、移动 C 到 A 后、
  // 另有新增 W（测试中不选择，验证未选条款不移植）
  // ------------------------------------------------------------------
  const ds = await newDraft('来源草案');
  await call('PUT', `/api/drafts/${ds}/clauses/A`, { title: '总则', body: 'AAA-源' });
  await call('POST', `/api/drafts/${ds}/clauses`, { key: 'D', title: '新条', body: 'DDD' });
  await call('POST', `/api/drafts/${ds}/refs`, { source: 'D', target: 'A', label: '依据' });
  await call('POST', `/api/drafts/${ds}/clauses/C/move`, { after: 'A' }); // A,C,B,D
  await call('POST', `/api/drafts/${ds}/clauses`, { key: 'W', title: '未选条款', body: 'WWW' });
  const dsMeta = await call('GET', `/api/drafts/${ds}`);

  // 目标草案 dt（基线 v1）：改 B 正文（与来源不相交）
  const dt = await newDraft('目标草案');
  await call('PUT', `/api/drafts/${dt}/clauses/B`, { title: '会员', body: 'BBB-目' });

  // ------------------------------------------------------------------
  // 1) 入参校验
  // ------------------------------------------------------------------
  let err = await call('POST', `/api/drafts/${dt}/transplant-preview`, { source_id: ds, keys: [] }, 400);
  ok(err.error === 'VALIDATION', '空选择 -> 400 VALIDATION');
  err = await call('POST', `/api/drafts/${dt}/transplant-preview`, { source_id: dt, keys: ['A'] }, 400);
  ok(err.error === 'VALIDATION', '来源与目标相同 -> 400 VALIDATION');
  err = await call('POST', `/api/drafts/${dt}/transplant-preview`, { source_id: 9999, keys: ['A'] }, 404);
  ok(err.error === 'NOT_FOUND', '来源草案不存在 -> 404');
  err = await call('POST', `/api/drafts/${dt}/transplant-preview`, { source_id: ds, keys: ['B'] }, 400);
  ok(err.error === 'VALIDATION' && err.keys.includes('B'), '来源对该标识无改动 -> 400 并列明标识');

  // ------------------------------------------------------------------
  // 2) 预演：返回移植后顺序/正文/引用差异与凭据，且不修改任何草案
  // ------------------------------------------------------------------
  const pv = await call('POST', `/api/drafts/${dt}/transplant-preview`, { source_id: ds, keys: ['A', 'C', 'D'] }, 200);
  ok(pv.preview === true && /^[0-9a-f]{64}$/.test(pv.token), '预演成功返回 64 位十六进制确认凭据');
  ok(pv.target_id === dt && pv.source_id === ds && pv.baseline_id === 1, '预演回显目标/来源/共同基线');
  ok(pv.target_revision === 2 && pv.source_revision === dsMeta.revision, '预演记录两份草案的修订号');
  ok(pv.final.order.join(',') === 'A,C,B,D', '预演给出移植后条款顺序 A,C,B,D');
  ok(pv.final.clauses.find((c) => c.key === 'A').body === 'AAA-源', '预演给出移植后标题正文');
  ok(pv.final.clauses.find((c) => c.key === 'B').body === 'BBB-目', '目标自身改动在预演结果中保留');
  ok(pv.final.refs.some((r) => r.source === 'D' && r.target === 'A'), '新增条款的出站引用随条款移植');
  ok(pv.final.refs.some((r) => r.source === 'B' && r.target === 'A'), '目标既有引用保留');
  ok(pv.diff.added.join(',') === 'D' && pv.diff.moved.includes('C'), '预演差异含新增 D 与移动 C');
  ok(pv.diff.changed.some((c) => c.key === 'A' && c.body), '预演差异含 A 正文修改');
  ok(pv.changed_detail.find((c) => c.key === 'A').bodySegments.some((s) => s.op === 'ins'), '预演给出正文逐字差异');
  ok(pv.diff.refs_added.some((r) => r.source === 'D' && r.target === 'A'), '预演给出出站引用差异');
  ok(pv.applied.length === 3 && !pv.converged.length, '预演列出将应用的 3 项改动');
  // 预演不写内容：两份草案保持原样
  let det = await call('GET', `/api/drafts/${dt}`);
  ok(det.revision === 2 && orderOf(det) === 'A,B,C' && det.clauses.find((c) => c.key === 'A').body === 'AAA',
    '预演不修改目标草案（顺序/正文/修订号不变）');
  det = await call('GET', `/api/drafts/${ds}`);
  ok(det.revision === dsMeta.revision, '预演不修改来源草案');

  // ------------------------------------------------------------------
  // 3) 确认：只更新目标；记一次可撤销操作；来源与未选条款保持原样
  // ------------------------------------------------------------------
  const cf = await call('POST', `/api/drafts/${dt}/transplant-confirm`, { token: pv.token }, 200);
  ok(cf.ok === true && cf.transplanted === true && cf.applied.length === 3, '确认成功并回显应用项');
  ok(orderOf(cf.draft) === 'A,C,B,D', '确认后目标顺序为 A,C,B,D');
  ok(cf.draft.clauses.find((c) => c.key === 'A').body === 'AAA-源', '确认后目标含来源的 A 修改');
  ok(cf.draft.clauses.find((c) => c.key === 'B').body === 'BBB-目', '确认后目标自身改动保留');
  ok(!cf.draft.clauses.some((c) => c.key === 'W'), '未选条款 W 未移植');
  ok(cf.draft.refs.some((r) => r.source === 'D' && r.target === 'A'), '确认后目标含 D 的出站引用');
  ok(cf.history.operations.some((o) => o.kind === 'transplant' && o.summary.includes('来源草案')),
    '目标操作历史记为一次移植操作');
  const srcAfter = await call('GET', `/api/drafts/${ds}`);
  ok(srcAfter.revision === dsMeta.revision && orderOf(srcAfter) === 'A,C,B,D,W',
    '来源草案保持原样（内容与修订号不变）');

  // 凭据不可重复使用
  err = await call('POST', `/api/drafts/${dt}/transplant-confirm`, { token: pv.token }, 409);
  ok(err.error === 'TRANSPLANT_ALREADY_CONSUMED', '凭据重复使用 -> 409 TRANSPLANT_ALREADY_CONSUMED');
  // 不存在的凭据
  err = await call('POST', `/api/drafts/${dt}/transplant-confirm`, { token: 'f'.repeat(64) }, 404);
  ok(err.error === 'TRANSPLANT_TOKEN_NOT_FOUND', '凭据不存在 -> 404 TRANSPLANT_TOKEN_NOT_FOUND');
  err = await call('POST', `/api/drafts/${dt}/transplant-confirm`, { token: 'not-a-token' }, 400);
  ok(err.error === 'VALIDATION', '凭据格式非法 -> 400 VALIDATION');

  // ------------------------------------------------------------------
  // 4) 移植可撤销、可重做（一次操作整体还原）
  // ------------------------------------------------------------------
  let h = await call('GET', `/api/drafts/${dt}/history`);
  let r = await call('POST', `/api/drafts/${dt}/undo`, { revision: h.revision }, 200);
  ok(r.applied_kind === 'transplant' && orderOf(r.draft) === 'A,B,C', '撤销移植：顺序整体还原');
  ok(r.draft.clauses.find((c) => c.key === 'A').body === 'AAA' && !r.draft.clauses.some((c) => c.key === 'D'),
    '撤销移植：正文与新增条款一并还原');
  r = await call('POST', `/api/drafts/${dt}/redo`, { revision: r.history.revision }, 200);
  ok(orderOf(r.draft) === 'A,C,B,D' && r.draft.clauses.find((c) => c.key === 'A').body === 'AAA-源',
    '重做移植：改动整体恢复');

  // ------------------------------------------------------------------
  // 5) 修订号校验：预演后来源或目标任一变化 -> 拒绝旧确认
  // ------------------------------------------------------------------
  const dt2 = await newDraft('目标2');
  const pv2 = await call('POST', `/api/drafts/${dt2}/transplant-preview`, { source_id: ds, keys: ['A'] }, 200);
  await call('PUT', `/api/drafts/${ds}/clauses/A`, { title: '总则', body: 'AAA-源2' }); // 来源变了
  err = await call('POST', `/api/drafts/${dt2}/transplant-confirm`, { token: pv2.token }, 409);
  ok(err.error === 'TRANSPLANT_STALE_REVISION', '预演后来源被编辑 -> 409 TRANSPLANT_STALE_REVISION');
  ok(err.source_revision > pv2.source_revision, '拒绝响应返回当前来源修订号');
  // 目标变化同样拒绝
  const pv3 = await call('POST', `/api/drafts/${dt2}/transplant-preview`, { source_id: ds, keys: ['A'] }, 200);
  await call('PUT', `/api/drafts/${dt2}/clauses/B`, { title: '会员', body: 'BBB-2' }); // 目标变了
  err = await call('POST', `/api/drafts/${dt2}/transplant-confirm`, { token: pv3.token }, 409);
  ok(err.error === 'TRANSPLANT_STALE_REVISION', '预演后目标被编辑 -> 409 TRANSPLANT_STALE_REVISION');
  // 重新预演后可确认（内容跟随最新来源）
  const pv4 = await call('POST', `/api/drafts/${dt2}/transplant-preview`, { source_id: ds, keys: ['A'] }, 200);
  const cf4 = await call('POST', `/api/drafts/${dt2}/transplant-confirm`, { token: pv4.token }, 200);
  ok(cf4.draft.clauses.find((c) => c.key === 'A').body === 'AAA-源2', '重新预演后确认成功，内容跟随最新来源');
  // 同一目标重新预演使旧凭据作废
  const pv5 = await call('POST', `/api/drafts/${dt2}/transplant-preview`, { source_id: ds, keys: ['D'] }, 200);
  const pv6 = await call('POST', `/api/drafts/${dt2}/transplant-preview`, { source_id: ds, keys: ['D'] }, 200);
  err = await call('POST', `/api/drafts/${dt2}/transplant-confirm`, { token: pv5.token }, 404);
  ok(err.error === 'TRANSPLANT_TOKEN_NOT_FOUND', '同一目标重新预演后旧凭据作废 -> 404');
  await call('POST', `/api/drafts/${dt2}/transplant-confirm`, { token: pv6.token }, 200);

  // ------------------------------------------------------------------
  // 6) 冲突：目标对所选条款已有不同改动 -> 逐条说明
  // ------------------------------------------------------------------
  // modify-modify：dtC1 也改 A（不同内容）
  const dtC1 = await newDraft('冲突-改A');
  await call('PUT', `/api/drafts/${dtC1}/clauses/A`, { title: '总则', body: 'AAA-另' });
  err = await call('POST', `/api/drafts/${dtC1}/transplant-preview`, { source_id: ds, keys: ['A'] }, 409);
  ok(err.error === 'TRANSPLANT_CONFLICT' && err.conflicts[0].kind === 'modify-modify' && err.conflicts[0].key === 'A',
    '双方改同一条款 -> 409 TRANSPLANT_CONFLICT（modify-modify）');
  ok(err.token === undefined, '冲突预演不发凭据');

  // modify-delete：dtC2 删除了 A
  const dtC2 = await newDraft('冲突-删A');
  await call('DELETE', `/api/drafts/${dtC2}/clauses/A`);
  err = await call('POST', `/api/drafts/${dtC2}/transplant-preview`, { source_id: ds, keys: ['A'] }, 409);
  ok(err.conflicts && err.conflicts[0].kind === 'modify-delete', '来源修改、目标删除 -> modify-delete');

  // delete-modify：dsDel 删除 B（并清理 B->A 出边），dtC3 改 B
  const dsDel = await newDraft('来源-删B');
  await call('DELETE', `/api/drafts/${dsDel}/clauses/B`);
  let delDet = await call('GET', `/api/drafts/${dsDel}`);
  for (const ref of delDet.refs.filter((x) => x.source === 'B' || x.target === 'B').map((x) => x.ordinal).sort((a, b) => b - a)) {
    await call('DELETE', `/api/drafts/${dsDel}/refs/${ref}`);
  }
  const dtC3 = await newDraft('冲突-改B');
  await call('PUT', `/api/drafts/${dtC3}/clauses/B`, { title: '会员', body: 'BBB-冲突' });
  err = await call('POST', `/api/drafts/${dtC3}/transplant-preview`, { source_id: dsDel, keys: ['B'] }, 409);
  ok(err.conflicts && err.conflicts[0].kind === 'delete-modify', '来源删除、目标修改 -> delete-modify');

  // add-add：dsAdd 与 dtC4 都新增 X，内容不同
  const dsAdd = await newDraft('来源-增X');
  await call('POST', `/api/drafts/${dsAdd}/clauses`, { key: 'X', title: 'X条', body: 'x-源' });
  const dtC4 = await newDraft('冲突-增X');
  await call('POST', `/api/drafts/${dtC4}/clauses`, { key: 'X', title: 'X条', body: 'x-目' });
  err = await call('POST', `/api/drafts/${dtC4}/transplant-preview`, { source_id: dsAdd, keys: ['X'] }, 409);
  ok(err.conflicts && err.conflicts[0].kind === 'add-add', '双方同标识新增内容不同 -> add-add');

  // move-move：ds 移动 C 到 A 后；dtC5 移动 C 到最前
  const dtC5 = await newDraft('冲突-移C');
  await call('POST', `/api/drafts/${dtC5}/clauses/C/move`, { ordinal: 0 });
  err = await call('POST', `/api/drafts/${dtC5}/transplant-preview`, { source_id: ds, keys: ['C'] }, 409);
  ok(err.conflicts && err.conflicts[0].kind === 'move-move', '双方移动同一条款到不同落点 -> move-move');

  // refs-conflict：dsRef 改 A 出边（A->C），dtC6 改 A 出边（A->B）
  const dsRef = await newDraft('来源-改引用');
  await call('POST', `/api/drafts/${dsRef}/refs`, { source: 'A', target: 'C', label: '' });
  const dtC6 = await newDraft('冲突-改引用');
  await call('POST', `/api/drafts/${dtC6}/refs`, { source: 'A', target: 'B', label: '' });
  err = await call('POST', `/api/drafts/${dtC6}/transplant-preview`, { source_id: dsRef, keys: ['A'] }, 409);
  ok(err.conflicts && err.conflicts[0].kind === 'refs-conflict', '双方出站引用改成不同集合 -> refs-conflict');

  // 冲突预演后两份草案均未改动
  det = await call('GET', `/api/drafts/${dtC6}`);
  ok(det.clauses.find((c) => c.key === 'A').body === 'AAA' && det.refs.length === 2, '冲突拒绝后目标草案保持原样');

  // ------------------------------------------------------------------
  // 7) 收敛：已相同的改动不算冲突；全部相同 -> NO_CHANGES
  // ------------------------------------------------------------------
  const dtSame = await newDraft('收敛-同改A');
  await call('PUT', `/api/drafts/${dtSame}/clauses/A`, { title: '总则', body: 'AAA-源2' }); // 与来源当前内容相同
  err = await call('POST', `/api/drafts/${dtSame}/transplant-preview`, { source_id: ds, keys: ['A'] }, 400);
  ok(err.error === 'NO_CHANGES' && err.converged.some((c) => c.key === 'A'), '已相同的改动收敛 -> 400 NO_CHANGES');
  // 部分应用 + 部分收敛：选 A（收敛）与 D（应用）
  const pvMix = await call('POST', `/api/drafts/${dtSame}/transplant-preview`, { source_id: ds, keys: ['A', 'D'] }, 200);
  ok(pvMix.applied.some((a) => a.key === 'D') && pvMix.converged.some((c) => c.key === 'A'),
    '部分应用、部分收敛时预演成功并分别列出');
  await call('POST', `/api/drafts/${dtSame}/transplant-confirm`, { token: pvMix.token }, 200);

  // ------------------------------------------------------------------
  // 8) 悬空：移植新造成悬空引用 -> 整次拒绝并列明（不自动移入引用目标）
  // ------------------------------------------------------------------
  const dsEz = await newDraft('来源-增EZ');
  await call('POST', `/api/drafts/${dsEz}/clauses`, { key: 'E', title: 'E条', body: 'EEE' });
  await call('POST', `/api/drafts/${dsEz}/clauses`, { key: 'Z', title: 'Z条', body: 'ZZZ' });
  await call('POST', `/api/drafts/${dsEz}/refs`, { source: 'E', target: 'Z', label: '见' });
  const dtD = await newDraft('目标-悬空');
  err = await call('POST', `/api/drafts/${dtD}/transplant-preview`, { source_id: dsEz, keys: ['E'] }, 409);
  ok(err.error === 'TRANSPLANT_DANGLING' && err.dangling.some((d) => d.source === 'E' && d.target === 'Z'),
    '只移植 E 而新造成 E->Z 悬空 -> 409 TRANSPLANT_DANGLING 并列明引用');
  det = await call('GET', `/api/drafts/${dtD}`);
  ok(det.clauses.length === 3 && det.revision === 1, '悬空拒绝后目标草案内容与历史不变');
  // 一并选择 Z -> 成功
  const pvEz = await call('POST', `/api/drafts/${dtD}/transplant-preview`, { source_id: dsEz, keys: ['E', 'Z'] }, 200);
  ok(pvEz.final.order.join(',') === 'A,B,C,E,Z', '引用目标一并选择后预演成功');
  await call('POST', `/api/drafts/${dtD}/transplant-confirm`, { token: pvEz.token }, 200);

  // 移植删除造成入边悬空：dsDel 删除了 B；dtKeep 中 C->B 引用残留
  const dsDelB = await newDraft('来源-删B带引用');
  await call('DELETE', `/api/drafts/${dsDelB}/clauses/B`);
  delDet = await call('GET', `/api/drafts/${dsDelB}`);
  for (const ref of delDet.refs.filter((x) => x.source === 'B' || x.target === 'B').map((x) => x.ordinal).sort((a, b) => b - a)) {
    await call('DELETE', `/api/drafts/${dsDelB}/refs/${ref}`);
  }
  const dtKeep = await newDraft('目标-引入边');
  await call('POST', `/api/drafts/${dtKeep}/refs`, { source: 'C', target: 'B', label: '见B' });
  err = await call('POST', `/api/drafts/${dtKeep}/transplant-preview`, { source_id: dsDelB, keys: ['B'] }, 409);
  ok(err.error === 'TRANSPLANT_DANGLING' && err.dangling.some((d) => d.source === 'C' && d.target === 'B'),
    '移植删除使目标既有引用 C->B 悬空 -> 整次拒绝并列明');

  // 干净的删除移植：目标无 B 相关引用残留
  const dtClean = await newDraft('目标-干净删除');
  const pvDel = await call('POST', `/api/drafts/${dtClean}/transplant-preview`, { source_id: dsDelB, keys: ['B'] }, 200);
  ok(pvDel.final.order.join(',') === 'A,C' && pvDel.final.refs.length === 0, '删除移植：B 及其出边一并移除');
  await call('POST', `/api/drafts/${dtClean}/transplant-confirm`, { token: pvDel.token }, 200);

  // ------------------------------------------------------------------
  // 9) 移植确认使目标旧的发布预览凭据失效
  // ------------------------------------------------------------------
  const dtPub = await newDraft('目标-发布预览');
  await call('PUT', `/api/drafts/${dtPub}/clauses/B`, { title: '会员', body: 'BBB-发布预览' });
  const pubPv = await call('POST', `/api/drafts/${dtPub}/preview`, {}, 200);
  const pvT = await call('POST', `/api/drafts/${dtPub}/transplant-preview`, { source_id: ds, keys: ['A'] }, 200);
  await call('POST', `/api/drafts/${dtPub}/transplant-confirm`, { token: pvT.token }, 200);
  err = await call('POST', `/api/drafts/${dtPub}/publish`, { preview_token: pubPv.token }, 404);
  ok(err.error === 'PREVIEW_TOKEN_NOT_FOUND', '移植确认后目标旧的发布预览凭据失效 -> 404');

  // ------------------------------------------------------------------
  // 10) 前提约束：基线不同 / 来源已发布 / 目标已发布
  // ------------------------------------------------------------------
  // 发布 dt（含移植结果）为 v2，制造另一基线
  await call('POST', `/api/drafts/${dt}/publish`, { note: 'v2' }, 201);
  const dV2 = await newDraft('v2基线草案'); // 默认基线 = 最新版 v2
  err = await call('POST', `/api/drafts/${dV2}/transplant-preview`, { source_id: ds, keys: ['A'] }, 409);
  ok(err.error === 'BASELINE_MISMATCH', '基线不同 -> 409 BASELINE_MISMATCH');
  err = await call('POST', `/api/drafts/${dV2}/transplant-preview`, { source_id: dt, keys: ['A'] }, 409);
  ok(err.error === 'SOURCE_CLOSED', '来源草案已发布 -> 409 SOURCE_CLOSED');
  err = await call('POST', `/api/drafts/${dt}/transplant-preview`, { source_id: ds, keys: ['A'] }, 409);
  ok(err.error === 'CLOSED', '目标草案已发布 -> 409 CLOSED');

  // 移植后的目标可正常发布（移植结果与现有发布流程兼容；dtD 只新增了 E、Z，重放到 v2 不相交）
  const pub3 = await call('POST', `/api/drafts/${dtD}/publish`, { note: 'v3 含移植' }, 201);
  const v3 = await call('GET', `/api/versions/${pub3.version_id}`);
  ok(v3.clauses.some((c) => c.key === 'E') && v3.clauses.some((c) => c.key === 'Z'),
    '移植后的目标草案可按现有流程发布为新版本');

  console.log(`\n${pass} 项草案间移植端到端断言全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
