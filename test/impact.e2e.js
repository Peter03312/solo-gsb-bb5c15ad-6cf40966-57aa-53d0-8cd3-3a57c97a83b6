'use strict';
// 草案引用影响链 端到端冒烟测试。
// 用法：先启动服务，再 E2E_BASE=http://127.0.0.1:PORT node test/impact.e2e.js
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

async function main() {
  // v1：B→A（参见），C→B，D→C —— 修改 A 将沿 B、C、D 反向波及
  await call('POST', '/api/initialize', {
    charter_title: '影响链测试章程',
    clauses: [
      { key: 'A', title: '总则', body: 'AAA' },
      { key: 'B', title: '会员', body: 'BBB' },
      { key: 'C', title: '退出', body: 'CCC' },
      { key: 'D', title: '纪律', body: 'DDD' },
    ],
    refs: [
      { source: 'B', target: 'A', label: '参见' },
      { source: 'C', target: 'B', label: '见B' },
      { source: 'D', target: 'C', label: '' },
    ],
  }, 201);

  // ------------------------------------------------------------------
  // 1) 无改动草案：基线即最新版，影响链为空但响应带修订号/版本号
  // ------------------------------------------------------------------
  const d0 = await call('POST', '/api/drafts', { name: '空草案' }, 201);
  let imp = await call('GET', `/api/drafts/${d0.id}/impact`);
  ok(imp.draft_revision === 1, '响应带草案修订号');
  ok(imp.latest_version_id === 1 && imp.baseline_id === 1, '响应带最新版本号与基线号');
  ok(imp.replayed === false && imp.has_changes === false, '基线即最新版：未重放、无变化');
  ok(imp.sources.length === 0 && imp.affected.length === 0, '无改动：变化源与受影响均为空');
  ok(imp.candidate.clauses.length === 4 && imp.candidate.refs.length === 3, '候选版本即草案当前内容');

  // ------------------------------------------------------------------
  // 2) 修改 A：B 直接受影响、C/D 间接受影响，前后两版链分别给出
  // ------------------------------------------------------------------
  const d1 = await call('POST', '/api/drafts', { name: '改总则' }, 201);
  await call('PUT', `/api/drafts/${d1.id}/clauses/A`, { title: '总则', body: 'AAA-新版' });
  imp = await call('GET', `/api/drafts/${d1.id}/impact`);
  ok(imp.draft_revision === 2, '再次编辑后修订号递增并反映在查询响应中');
  ok(imp.sources.length === 1 && imp.sources[0].key === 'A', '唯一变化源为 A');
  ok(imp.sources[0].kinds.includes('body'), '变化源标记正文变化');
  const byKey = Object.fromEntries(imp.affected.map((a) => [a.key, a]));
  ok(byKey.B && byKey.B.relation === 'direct' && byKey.B.shortest_distance === 1, 'B 直接受影响');
  ok(byKey.C && byKey.C.relation === 'indirect' && byKey.C.shortest_distance === 2, 'C 间接受影响（2 跳）');
  ok(byKey.D.shortest_distance === 3, 'D 间接受影响（3 跳）');
  ok(JSON.stringify(byKey.C.shortest_chain.map((h) => h.target)) === JSON.stringify(['B', 'A']),
    '最短引用链为 C→B→A（hops 朝向变化源）');
  ok(byKey.B.before && byKey.B.after && byKey.B.before.distance === 1 && byKey.B.after.distance === 1,
    '变化前后两侧链分别给出（不拼接）');
  ok(byKey.C.status === 'still-referring', '引用未变：状态为变化前后均可达');
  ok(imp.stats.direct_count === 1 && imp.stats.indirect_count === 2, '直接/间接统计正确');

  // ------------------------------------------------------------------
  // 3) 草案暂存悬空引用：阻塞，只说明原因、不返回影响结论
  // ------------------------------------------------------------------
  await call('POST', `/api/drafts/${d1.id}/refs`, { source: 'A', target: 'ZZZ', label: '悬空' });
  const blocked = await call('GET', `/api/drafts/${d1.id}/impact`, null, 409);
  ok(blocked.error === 'DRAFT_INVALID' && blocked.reason === 'draft-invalid', '悬空引用草案：DRAFT_INVALID 阻塞');
  ok(blocked.sources === undefined && blocked.affected === undefined, '阻塞时不返回影响结论');
  ok(blocked.issues.some((i) => i.code === 'dangling-ref'), '阻塞响应列出悬空引用原因');
  ok(blocked.draft_revision === 3, '阻塞响应仍带当前草案修订号');
  // 修复（撤销悬空引用操作）后重新查询应恢复结论
  await call('POST', `/api/drafts/${d1.id}/undo`, { revision: 3 }, 200);
  imp = await call('GET', `/api/drafts/${d1.id}/impact`);
  ok(imp.draft_revision === 4 && imp.sources.length === 1, '撤销（修订号再变）后重新查询反映新状态');

  // d1 发布 -> v2（立即生效）
  await call('POST', `/api/drafts/${d1.id}/publish`, { note: 'v2 改A' }, 201);

  // ------------------------------------------------------------------
  // 4) 基线落后的草案：不相交改动可重放，影响链基于重放候选版本
  // ------------------------------------------------------------------
  // v2 改了 A；d2 基于 v1 只改 D 的正文（D 无出边，与 v2 不相交）
  const d2 = await call('POST', '/api/drafts', { name: '改纪律', baseline_id: 1 }, 201);
  await call('PUT', `/api/drafts/${d2.id}/clauses/D`, { title: '纪律', body: 'DDD-改' });
  imp = await call('GET', `/api/drafts/${d2.id}/impact`);
  ok(imp.latest_version_id === 2 && imp.replayed === true, '基线落后：已重放到最新版 v2');
  ok(imp.sources.map((s) => s.key).includes('D'), '重放候选版本相对最新版的变化源含 D');
  ok(imp.candidate.clauses.find((c) => c.key === 'A').body === 'AAA-新版', '候选版本同时包含最新版的 A 修改');

  // ------------------------------------------------------------------
  // 5) 基线落后且与最新版冲突：阻塞、说明冲突、不给影响结论
  // ------------------------------------------------------------------
  const d3 = await call('POST', '/api/drafts', { name: '也改A', baseline_id: 1 }, 201);
  await call('PUT', `/api/drafts/${d3.id}/clauses/A`, { title: '总则', body: 'AAA-另一种改法' });
  const conflicted = await call('GET', `/api/drafts/${d3.id}/impact`, null, 409);
  ok(conflicted.error === 'IMPACT_REPLAY_CONFLICT' && conflicted.reason === 'replay-conflict',
    '重放冲突：IMPACT_REPLAY_CONFLICT 阻塞');
  ok(conflicted.conflicts.some((c) => c.kind === 'modify-modify'), '阻塞响应说明 modify-modify 冲突');
  ok(conflicted.sources === undefined, '冲突时不返回影响结论');

  // ------------------------------------------------------------------
  // 6) 基线落后且重放产生悬空引用：阻塞并列明悬空引用
  //    触发条件：最新版新增了一条草案基线中不存在的入边，指向被草案删除的条款。
  //    先发布 d2（改 D）为 v3；再：
  //    - dEdge（基于 v3）新增引用 D→B 后发布 -> v4；
  //    - d4（基于 v3）删除 B，并清掉自身状态里涉及 B 的边（B→A、C→B）；
  //      v4 才有的 D→B 在草案基线 v3 中不存在，草案无从清理、自身不悬空；
  //    - 重放到 v4 时 D 采纳自最新版（草案未动 D），D→B 随其保留而 B 已删 -> 悬空。
  // ------------------------------------------------------------------
  await call('POST', `/api/drafts/${d2.id}/publish`, { note: 'v3 改D' }, 201);
  const dEdge = await call('POST', '/api/drafts', { name: '加D引用B', baseline_id: 3 }, 201);
  await call('POST', `/api/drafts/${dEdge.id}/refs`, { source: 'D', target: 'B', label: '追溯B' });
  await call('POST', `/api/drafts/${dEdge.id}/publish`, { note: 'v4 D引B' }, 201);

  const d4 = await call('POST', '/api/drafts', { name: '删B', baseline_id: 3 }, 201);
  await call('DELETE', `/api/drafts/${d4.id}/clauses/B`); // 其相关边在草案中暂存为悬空
  // 删除草案状态中涉及 B 的边（B→A、C→B），保留 D→C；倒序删除避免 ordinal 错位
  let det = await call('GET', `/api/drafts/${d4.id}`);
  const bRefOrdinals = det.refs
    .filter((r) => r.source === 'B' || r.target === 'B')
    .map((r) => r.ordinal)
    .sort((a, b) => b - a);
  for (const ord of bRefOrdinals) {
    await call('DELETE', `/api/drafts/${d4.id}/refs/${ord}`);
  }
  det = await call('GET', `/api/drafts/${d4.id}`);
  ok(det.issues.filter((i) => i.level === 'error').length === 0, 'd4 草案自身无悬空（不含 v4 才有的 D→B）');
  const dangling = await call('GET', `/api/drafts/${d4.id}/impact`, null, 409);
  ok(dangling.error === 'IMPACT_REPLAY_CONFLICT' && dangling.reason === 'replay-conflict',
    '重放悬空：IMPACT_REPLAY_CONFLICT 阻塞');
  ok(dangling.dangling.some((g) => g.source === 'D' && g.target === 'B'), '阻塞响应列明悬空引用 D→B');
  ok(dangling.sources === undefined && dangling.draft_revision >= 1, '悬空时不返回影响结论但仍带修订号/版本号');

  // ------------------------------------------------------------------
  // 7) 其他草案发布后重新查询：最新版本号变化，结论基于新最新版
  //    d1（改 A）的改动早已并入 v2，后续 v3/v4 未再动 A：重放到 v4 无差异。
  // ------------------------------------------------------------------
  imp = await call('GET', `/api/drafts/${d1.id}/impact`, null, 200);
  ok(imp.draft_status === 'published' && imp.latest_version_id === 4, '已发布草案也可只读查看影响链（最新版已到 v4）');
  ok(imp.has_changes === false, '已发布：其改动已完全并入当前最新版，重放后无差异');
  const stillConflict = await call('GET', `/api/drafts/${d3.id}/impact`, null, 409);
  ok(stillConflict.latest_version_id === 4, '其他草案发布后重新查询：最新版本号反映新状态');

  // ------------------------------------------------------------------
  // 8) 不存在的草案 / 查询只读（不改变草案修订号）
  // ------------------------------------------------------------------
  const nf = await fetch(base + '/api/drafts/9999/impact');
  ok(nf.status === 404, '不存在草案返回 404');
  const revBefore = (await call('GET', `/api/drafts/${d3.id}`)).revision;
  await call('GET', `/api/drafts/${d3.id}/impact`, null, 409);
  await call('GET', `/api/drafts/${d3.id}/impact`, null, 409);
  const revAfter = (await call('GET', `/api/drafts/${d3.id}`)).revision;
  ok(revBefore === revAfter, '影响链查询只读：重复查询不改变草案修订号');

  console.log(`\n引用影响链端到端测试通过（${pass} 项）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
