'use strict';
// 纯逻辑测试：node test/model.test.js
const assert = require('assert');
const {
  buildState,
  touchedClauses,
  replayDraft,
  validateState,
  hasBlockingIssues,
  diffStates,
  movedKeys,
  textDiff,
  reverseReachable,
  impactChangeSources,
  referenceImpact,
} = require('../src/model');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function S(order, clauses, edges = []) {
  return buildState({
    order,
    clauses: clauses.map(([key, title, body]) => ({ key, title, body: body || title })),
    edges,
  });
}

const baseline = S(
  ['A', 'B', 'C'],
  [
    ['A', '总则'],
    ['B', '会员'],
    ['C', '附则'],
  ],
  [{ source: 'A', target: 'B', label: '见' }],
);

test('不相交改动可重放：草案改 A，最新版改 C', () => {
  const draft = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则修订', '新内容'],
      ['B', '会员'],
      ['C', '附则'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const latest = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则'],
      ['B', '会员'],
      ['C', '附则修订'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.merged.clauses.get('A').title, '总则修订');
  assert.strictEqual(r.merged.clauses.get('C').title, '附则修订');
});

test('同一条款双方改动 -> modify-modify 冲突', () => {
  const draft = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则Y'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflicts[0].kind, 'modify-modify');
  assert.strictEqual(r.conflicts[0].key, 'A');
});

test('双方同样修改（收敛）不冲突', () => {
  const draft = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok);
});

test('草案删除、最新版修改 -> delete-modify 冲突', () => {
  const draft = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const latest = S(['A', 'B', 'C'], [['A', '总则X'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'delete-modify' && c.key === 'A'));
});

test('双方都删除 A -> 收敛，结果不含 A', () => {
  const draft = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const latest = S(['B', 'C'], [['B', '会员'], ['C', '附则']], []);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.ok(!r.merged.clauses.has('A'));
  assert.deepStrictEqual(r.merged.order, ['B', 'C']);
});

test('重放后引用悬空（草案删 B，但保留 A->B 引用为悬空暂存；最新版没动）-> 拒绝', () => {
  // 删除条款时入边保留在草案中（可暂存的悬空引用）
  const draft = S(
    ['A', 'C'],
    [
      ['A', '总则'],
      ['C', '附则'],
    ],
    [{ source: 'A', target: 'B', label: '见' }],
  );
  const latest = S(
    ['A', 'B', 'C'],
    [
      ['A', '总则'],
      ['B', '会员'],
      ['C', '附则'],
    ],
    [
      { source: 'A', target: 'B', label: '见' },
      { source: 'C', target: 'A', label: '' },
    ],
  );
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.dangling.some((d) => d.source === 'A' && d.target === 'B'));
});

test('草案删除 B 且最新版也删除 B（引用一并消失）-> 不悬空', () => {
  const draft = S(['A', 'C'], [['A', '总则'], ['C', '附则']], []);
  const latest = S(['A', 'C'], [['A', '总则'], ['C', '附则']], []);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.merged.edges.length, 0);
});

test('新增条款不相交：草案加 D，最新版加 E，顺序按锚点插入', () => {
  const draft = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '附则二']], baseline.edges);
  const latest = S(['A', 'E', 'B', 'C'], [['A', '总则'], ['E', '新增E'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  // E 在最新版的位置（A 后），D 由草案放置在末尾
  assert.deepStrictEqual(r.merged.order, ['A', 'E', 'B', 'C', 'D']);
});

test('双方新增同标识但内容不同 -> add-add 冲突', () => {
  const draft = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '草案的D']], baseline.edges);
  const latest = S(['A', 'B', 'C', 'D'], [['A', '总则'], ['B', '会员'], ['C', '附则'], ['D', '最新版的D']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft });
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'add-add'));
});

test('草案移动 B 到末尾，最新版改 C：重放后 B 在末尾', () => {
  const draft = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则'], ['B', '会员'], ['C', '附则X']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft, draftMoved: new Set(['B']) });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.deepStrictEqual(r.merged.order, ['A', 'C', 'B']);
  assert.strictEqual(r.merged.clauses.get('C').title, '附则X');
  assert.ok(r.mergedMoved.has('B'));
});

test('草案前移 C（显式移动 C），最新版只改 B 正文：不相交，可重放', () => {
  const draft = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const latest = S(['A', 'B', 'C'], [['A', '总则'], ['B', '会员修订'], ['C', '附则']], baseline.edges);
  const r = replayDraft({ baseline, latest, draft, draftMoved: new Set(['C']) });
  assert.ok(r.ok, JSON.stringify(r.conflicts));
  assert.deepStrictEqual(r.merged.order, ['A', 'C', 'B']);
  assert.strictEqual(r.merged.clauses.get('B').title, '会员修订');
});

test('显式移动集合用于触碰判定（被动让位条款不算移动）', () => {
  const other = S(['A', 'C', 'B'], [['A', '总则'], ['B', '会员'], ['C', '附则']], baseline.edges);
  const t = touchedClauses(baseline, other, new Set(['C']));
  assert.ok(t.get('C').position); // C 被显式移动
  assert.strictEqual(t.get('B'), undefined); // B 只是被动让位
  assert.strictEqual(t.get('A'), undefined);
});

test('草案可暂存悬空引用：validate 报 error，阻止发布', () => {
  const s = S(['A'], [['A', '总则']], [{ source: 'A', target: 'ZZZ', label: '' }]);
  const issues = validateState(s);
  assert.ok(issues.some((i) => i.code === 'dangling-ref'));
  assert.ok(hasBlockingIssues(issues));
});

test('结构差异：新增/删除/修改分类', () => {
  const d = diffStates(
    baseline,
    S(['A', 'C'], [['A', '总则改'], ['C', '附则']], [{ source: 'C', target: 'A', label: '' }]),
  );
  assert.deepStrictEqual(d.deleted, ['B']);
  assert.ok(d.changed.some((c) => c.key === 'A' && c.body));
  assert.strictEqual(d.refsRemoved.length, 1);
  assert.strictEqual(d.refsAdded.length, 1);
});

test('textDiff 中文按字标注增删', () => {
  const segs = textDiff('社团章程', '社团新章程');
  const ins = segs.filter((s) => s.op === 'ins').map((s) => s.text).join('');
  const del = segs.filter((s) => s.op === 'del').map((s) => s.text).join('');
  assert.strictEqual(ins, '新');
  assert.strictEqual(del, '');
});

test('movedKeys 检测前驱锚点变化（交换中只标记后移者）', () => {
  assert.deepStrictEqual([...movedKeys(['A', 'B', 'C'], ['A', 'C', 'B'])], ['B']);
});

// ---------------------------------------------------------------------------
// 生效排程
// ---------------------------------------------------------------------------
const {
  pickEffectiveVersion,
  pendingVersions,
  scheduleNeighbors,
} = require('../src/model');

const T0 = Date.parse('2026-01-01T00:00:00Z');
const H = 3600 * 1000;
function sch(rows) {
  // rows: [id, 相对 T0 的小时数, 状态]
  return rows.map(([id, h, status = 'scheduled']) => ({
    id,
    effective_at: new Date(T0 + h * H).toISOString(),
    schedule_status: status,
  }));
}

test('pickEffectiveVersion：取生效时刻已到且最大的版本；未到/已取消排除', () => {
  const vs = sch([
    [1, -10, 'immediate'], // v1 早已即时生效
    [2, 2, 'scheduled'],   // T0+2h 生效
    [3, 4, 'cancelled'],   // 被取消，永不生效
    [4, 6, 'scheduled'],   // 更晚
  ]);
  assert.strictEqual(pickEffectiveVersion(vs, T0 - H), 1);
  assert.strictEqual(pickEffectiveVersion(vs, T0), 1);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 2 * H), 2);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 3 * H), 2);
  // v3 被取消：跳过，仍是 v2
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 5 * H), 2);
  assert.strictEqual(pickEffectiveVersion(vs, T0 + 6 * H), 4);
  // 无任何已生效版本
  assert.strictEqual(pickEffectiveVersion(sch([[1, 1]]), T0), null);
});

test('pickEffectiveVersion：生效时刻相同时取较大 id（确定性）', () => {
  const vs = sch([
    [1, 0, 'immediate'],
    [2, 1, 'scheduled'],
  ]);
  // 构造相同时刻
  vs[1].effective_at = vs[0].effective_at;
  assert.strictEqual(pickEffectiveVersion(vs, T0 + H), 2);
});

test('pendingVersions：仅返回时刻仍在未来的 scheduled，按 id 升序', () => {
  const vs = sch([
    [1, -10, 'immediate'],
    [2, -1, 'scheduled'],  // 已到点（惰性生效），不在队列
    [3, 1, 'cancelled'],   // 取消，不在队列
    [4, 3, 'scheduled'],
    [5, 5, 'scheduled'],
  ]);
  assert.deepStrictEqual(pendingVersions(vs, T0).map((v) => v.id), [4, 5]);
});

test('scheduleNeighbors：按发布版顺序找相邻待生效版本', () => {
  const q = sch([
    [2, 1],
    [4, 3],
    [7, 5],
  ]);
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 4)).map(([k, v]) => [k, v?.id ?? null])),
    { before: 2, after: 7 },
  );
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 2)).map(([k, v]) => [k, v?.id ?? null])),
    { before: null, after: 4 },
  );
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(scheduleNeighbors(q, 7)).map(([k, v]) => [k, v?.id ?? null])),
    { before: 4, after: null },
  );
});

// ---------------------------------------------------------------------------
// 草案引用影响链
// ---------------------------------------------------------------------------
function impactFixture() {
  // 最新发布版：B→A（参见），C→B，D→C，E 独立
  const latest = S(
    ['A', 'B', 'C', 'D', 'E'],
    [['A', '总则'], ['B', '会员'], ['C', '退出'], ['D', '纪律'], ['E', '经费']],
    [
      { source: 'B', target: 'A', label: '参见' },
      { source: 'C', target: 'B', label: '见B' },
      { source: 'D', target: 'C', label: '' },
    ],
  );
  return latest;
}

test('impactChangeSources：标题/正文/出站引用变化与删除分类，纯位置移动不是变化源', () => {
  const latest = impactFixture();
  const candidate = S(
    ['A', 'B', 'C', 'E', 'D'], // D 仅移动位置
    [
      ['A', '总则新标题', '总则'], // 标题
      ['B', '会员', '会员改写'], // 正文 + 删除 B→A，新增 B→E
      ['C', '退出'],
      ['D', '纪律'],
      ['E', '经费'],
    ],
    [
      { source: 'B', target: 'E', label: '经费依据' },
      { source: 'C', target: 'B', label: '见B' },
      { source: 'D', target: 'C', label: '' },
    ],
  );
  const srcs = impactChangeSources(latest, candidate);
  const byKey = Object.fromEntries(srcs.map((s) => [s.key, s]));
  assert.deepStrictEqual(byKey.A.kinds, ['title']);
  assert.deepStrictEqual(byKey.B.kinds, ['body', 'refs']);
  assert.deepStrictEqual(byKey.B.refs_added, [{ source: 'B', target: 'E', label: '经费依据' }]);
  assert.deepStrictEqual(byKey.B.refs_removed, [{ source: 'B', target: 'A', label: '参见' }]);
  assert.strictEqual(byKey.D, undefined); // 纯移动不算变化源
  assert.strictEqual(byKey.E, undefined); // 被新引用指向但自身未变，不是变化源
});

test('新增条款不是变化源；删除条款是变化源', () => {
  const latest = impactFixture();
  // 仅新增 F（无入边/出边），不删除任何条款
  const candidate = S(
    ['A', 'B', 'C', 'D', 'E', 'F'],
    [['A', '总则'], ['B', '会员'], ['C', '退出'], ['D', '纪律'], ['E', '经费'], ['F', '附则新增']],
    [
      { source: 'B', target: 'A', label: '参见' },
      { source: 'C', target: 'B', label: '见B' },
      { source: 'D', target: 'C', label: '' },
    ],
  );
  assert.deepStrictEqual(impactChangeSources(latest, candidate), []);

  // 删除 B：B 是删除源；引用 B 的 C→B 若同时删除，C 的出站引用也变化（真实重放候选必须如此才不悬空）
  const candidate2 = S(
    ['A', 'C', 'D', 'E'],
    [['A', '总则'], ['C', '退出'], ['D', '纪律'], ['E', '经费']],
    [{ source: 'D', target: 'C', label: '' }],
  );
  const keys2 = impactChangeSources(latest, candidate2).map((s) => s.key);
  assert.deepStrictEqual(keys2.sort(), ['B', 'C']);
  assert.deepStrictEqual(impactChangeSources(latest, candidate2).find((s) => s.key === 'B').kinds, ['deleted']);
});

test('reverseReachable：反向 BFS 返回最短链，hops 按受影响条款→变化源排列', () => {
  const latest = impactFixture();
  const reach = reverseReachable(latest, 'A');
  assert.strictEqual(reach.get('B').distance, 1);
  assert.deepStrictEqual(reach.get('B').hops, [{ source: 'B', target: 'A', label: '参见' }]);
  assert.strictEqual(reach.get('C').distance, 2);
  assert.deepStrictEqual(reach.get('C').hops, [
    { source: 'C', target: 'B', label: '见B' },
    { source: 'B', target: 'A', label: '参见' },
  ]);
  assert.strictEqual(reach.get('D').distance, 3);
  assert.ok(!reach.has('E'));
  assert.ok(!reach.has('A')); // 不含变化源自身
});

test('reverseReachable：循环引用不重复、不死循环，取最短链', () => {
  const cyc = S(
    ['A', 'B', 'C'],
    [['A', 'a'], ['B', 'b'], ['C', 'c']],
    [
      { source: 'B', target: 'A' },
      { source: 'C', target: 'B' },
      { source: 'A', target: 'C' }, // A→C→B→A 成环
    ],
  );
  const reach = reverseReachable(cyc, 'A');
  assert.deepStrictEqual([...reach.keys()].sort(), ['B', 'C']);
  assert.strictEqual(reach.get('B').distance, 1);
  assert.strictEqual(reach.get('C').distance, 2); // 不绕环；A 不经环回到自身
});

test('referenceImpact：合并双版本追溯，直接/间接、变化前与变化后链分别给出', () => {
  const latest = impactFixture();
  // 候选：仅修改 A 正文，引用结构完全不变 -> 唯一变化源 A；两版追溯结果都在
  const candidate = S(
    ['A', 'B', 'C', 'D', 'E'],
    [['A', '总则', 'AA改'], ['B', '会员'], ['C', '退出'], ['D', '纪律'], ['E', '经费']],
    [
      { source: 'B', target: 'A', label: '参见' },
      { source: 'C', target: 'B', label: '见B' },
      { source: 'D', target: 'C', label: '' },
    ],
  );
  const r = referenceImpact({ latest, candidate });
  assert.deepStrictEqual(r.sources.map((s) => s.key), ['A']);
  const keys = new Map(r.affected.map((a) => [a.key, a]));
  assert.deepStrictEqual([...keys.keys()].sort(), ['B', 'C', 'D']);
  const b = keys.get('B');
  assert.strictEqual(b.relation, 'direct');
  assert.strictEqual(b.before.distance, 1);
  assert.strictEqual(b.after.distance, 1);
  assert.strictEqual(b.status, 'still-referring');
  const c = keys.get('C');
  assert.strictEqual(c.relation, 'indirect');
  assert.strictEqual(c.before.distance, 2);
  assert.strictEqual(c.after.distance, 2);
  // 最短链只包含同一版本的引用（变化后链即候选版链），不会跨版本拼接
  assert.deepStrictEqual(c.shortest_chain.map((h) => `${h.source}>${h.target}#${h.label}`), ['C>B#见B', 'B>A#参见']);
  const d = keys.get('D');
  assert.strictEqual(d.shortest_distance, 3);
  assert.strictEqual(r.stats.direct_count, 1);
  assert.strictEqual(r.stats.indirect_count, 2);
});

test('referenceImpact：变化后断开的入边标记 broken-after，链只取变化前一侧', () => {
  const latest = impactFixture();
  // 候选：A 修改；B→A 与 C→B 一并删除（B 自身出边变化也是源），D→C 保留
  const candidate = S(
    ['A', 'B', 'C', 'D', 'E'],
    [['A', '总则', 'AA改'], ['B', '会员'], ['C', '退出'], ['D', '纪律'], ['E', '经费']],
    [{ source: 'D', target: 'C', label: '' }],
  );
  const r = referenceImpact({ latest, candidate });
  const c = r.affected.find((a) => a.key === 'C');
  assert.ok(c, '变化前引用 B 的 C 仍作为受影响条款展示');
  // C→B（B 是引用变化源）为 1 跳；变化后 C→B 已删，链断
  assert.strictEqual(c.before.distance, 1);
  assert.strictEqual(c.after, null, '变化后 C 已无法经引用到达任何变化源');
  assert.strictEqual(c.status, 'broken-after');
  assert.strictEqual(c.relation, 'direct');
  assert.deepStrictEqual(c.shortest_chain.map((h) => h.target), ['B']);
  // D→C：C 自身是变化源（删除了 C→B），故 D 直接引用变化源 C，前后都在
  const d = r.affected.find((a) => a.key === 'D');
  assert.ok(d);
  assert.strictEqual(d.before.distance, 1);
  assert.strictEqual(d.after.distance, 1);
  assert.strictEqual(d.status, 'still-referring');
});

test('referenceImpact：变化后新增的引用链标记 added-chain，变化后仍可达优先取变化后链', () => {
  const latest = impactFixture();
  // 候选：A 修改；E 新增 E→A；B→A 保留
  const candidate = S(
    ['A', 'B', 'C', 'D', 'E'],
    [['A', '总则', 'AA改'], ['B', '会员'], ['C', '退出'], ['D', '纪律'], ['E', '经费']],
    [
      { source: 'B', target: 'A', label: '参见' },
      { source: 'C', target: 'B', label: '见B' },
      { source: 'D', target: 'C', label: '' },
      { source: 'E', target: 'A', label: '' },
    ],
  );
  const r = referenceImpact({ latest, candidate });
  const keys = new Map(r.affected.map((a) => [a.key, a]));
  const e = keys.get('E');
  assert.ok(e, '新增引用 E→A 使候选版既有条款 E 受影响');
  assert.strictEqual(e.before, null);
  assert.strictEqual(e.after.distance, 1);
  assert.strictEqual(e.status, 'added-chain');
  assert.strictEqual(e.relation, 'direct');
  const b = keys.get('B');
  assert.strictEqual(b.shortest_side, 'after'); // 变化后仍可达：优先变化后
  assert.deepStrictEqual(b.shortest_chain, [{ source: 'B', target: 'A', label: '参见' }]);
});

test('referenceImpact：删除的条款不作为受影响条款（已在变化源中列出）', () => {
  // 独立小图：X→Y（Y 被 X 引用）；候选删除 X。X 无入边，删除不改变其他条款出边。
  const latest = S(
    ['X', 'Y'],
    [['X', '经费'], ['Y', '审计']],
    [{ source: 'X', target: 'Y', label: '' }],
  );
  const candidate = S(['Y'], [['Y', '审计']], []);
  const r = referenceImpact({ latest, candidate });
  assert.deepStrictEqual(r.sources.map((s) => s.key), ['X']);
  assert.ok(!r.affected.some((a) => a.key === 'X'), '删除源不重复出现在受影响列表');
  assert.ok(!r.affected.some((a) => a.key === 'Y') || r.affected.find((a) => a.key === 'Y').after === null,
    'Y 即使被列为受影响条款，变化后侧也无链');
});

test('referenceImpact：删除被引用条款且入边一并清理时，旧入边来源标记 broken-after', () => {
  const latest = impactFixture();
  // 候选：删除 B；C→B 一并删除（否则候选悬空）。B 无其他入边。
  const candidate = S(
    ['A', 'C', 'D', 'E'],
    [['A', '总则'], ['C', '退出'], ['D', '纪律'], ['E', '经费']],
    [{ source: 'D', target: 'C', label: '' }],
  );
  const r = referenceImpact({ latest, candidate });
  assert.ok(r.sources.some((s) => s.key === 'B' && s.kinds.includes('deleted')));
  assert.ok(!r.affected.some((a) => a.key === 'B'), '删除条款不作为受影响条款');
  const c = r.affected.find((a) => a.key === 'C');
  assert.ok(c, '变化前引用 B 的 C 仍作为受影响条款展示');
  assert.strictEqual(c.after, null);
  assert.strictEqual(c.status, 'broken-after');
});

console.log(`\n${passed} 项测试全部通过`);
