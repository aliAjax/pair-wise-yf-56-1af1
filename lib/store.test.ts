import test from 'node:test';
import assert from 'node:assert/strict';
import { useIncidentStore, canReadParagraph, COSIGN_ROLES } from './store';
import type { Role } from './roles';

const store = useIncidentStore;
const st = () => store.getState();

function reset(role: Role = 'analyst') {
  st().resetDemo();
  st().setRole(role);
}
const b = () => st().incident.bulletin;
const active = () => b().approvals.filter((a) => a.status === 'active');

test('影响范围变化后：原批准失效、通报退回待审、版本+1、记录保留', () => {
  reset('responder');
  // 响应负责人先签
  assert.equal(st().signBulletin(1).ok, true);
  st().setRole('legal');
  assert.equal(st().signBulletin(1).ok, true);
  assert.equal(b().status, 'approved');
  assert.equal(active().length, 2);

  // 分析员补充受影响资产
  st().setRole('analyst');
  const r = st().addAffectedAsset('billing-service');
  assert.equal(r.ok, true);
  assert.equal(b().version, 2);
  assert.equal(b().status, 'pending', '已批准通报退回待审');
  assert.equal(active().length, 0, '生效批准清零');
  const invalidated = b().approvals.filter((a) => a.status === 'invalidated');
  assert.equal(invalidated.length, 2, '旧批准记录保留且标失效');
  assert.ok(invalidated.every((a) => a.invalidReason?.includes('影响范围')));
  // 时间线留有失效记录
  assert.ok(st().incident.timeline.some((e) => e.text.includes('原批准失效')));
});

test('处置状态变化同样触发修订失效（仅响应负责人可改）', () => {
  reset('analyst');
  st().setRole('legal');
  st().signBulletin(1);
  st().setRole('analyst');
  assert.equal(st().updateIncidentStatus('contained').ok, false, '分析员不能改处置状态');
  st().setRole('responder');
  const r = st().updateIncidentStatus('contained');
  assert.equal(r.ok, true);
  assert.equal(st().incident.status, 'contained');
  assert.equal(b().version, 2);
  assert.equal(b().status, 'pending');
  assert.equal(active().length, 0);
});

test('新证据触发修订；法务/公关改口径也使旧批准失效', () => {
  reset('legal');
  st().signBulletin(1);
  const r = st().addEvidence({ text: '发现第二个跳板主机', sensitive: true });
  assert.equal(r.ok, true);
  assert.equal(b().version, 2);
  assert.equal(active().length, 0);

  // 公关修改段落 -> v3
  st().setRole('pr');
  const para = b().paragraphs[0];
  const e = st().editBulletinParagraph(para.id, para.body + '（公关补充）');
  assert.equal(e.ok, true);
  assert.equal(b().version, 3);
  assert.equal(b().paragraphs[0].body.includes('公关补充'), true);
  // 分析员不能改口径
  st().setRole('analyst');
  assert.equal(st().editBulletinTitle('x').ok, false);
});

test('会签：同一角色重复确认只算一次', () => {
  reset('responder');
  assert.equal(st().signBulletin(1).ok, true);
  const dup = st().signBulletin(1);
  assert.equal(dup.ok, false, '重复会签被拒绝');
  assert.match(dup.message, /重复确认只算一次/);
  assert.equal(active().length, 1);
  // 非法角色不能签
  st().setRole('pr');
  assert.equal(st().signBulletin(1).ok, false, '公关不是会签角色');
  st().setRole('analyst');
  assert.equal(st().signBulletin(1).ok, false);
});

test('乐观锁：两个角色同时提交，后到一方看到版本变化被拒绝', () => {
  reset('responder');
  // 响应负责人打开时看到 v1
  st().signBulletin(1);
  // 此时公关改了口径，版本到 v2
  st().setRole('pr');
  const para = b().paragraphs[0];
  st().editBulletinParagraph(para.id, para.body + '（公关更新）');
  assert.equal(b().version, 2);
  // 法务拿着旧视图 v1 后到提交
  st().setRole('legal');
  const late = st().signBulletin(1);
  assert.equal(late.ok, false);
  assert.match(late.message, /版本已变化/);
  assert.equal(active().filter((a) => a.role === 'legal').length, 0, '旧版本会签未入账');
  // 同步后基于 v2 可签：法务补签 v2，响应负责人因内容已变也需在 v2 重签
  const synced = st().signBulletin(2);
  assert.equal(synced.ok, true);
  assert.equal(b().status, 'pending', '仅法务一人在 v2，还不满足双签');
  st().setRole('responder');
  assert.equal(st().signBulletin(2).ok, true);
  assert.equal(b().status, 'approved');
});

test('发布会签前不可发布；失败保留现场，重试只生成一条结果', () => {
  reset('responder');
  assert.equal(st().publishBulletin().ok, false, '未会签不能发布');
  st().signBulletin(1);
  st().setRole('legal');
  st().signBulletin(1);
  const fail = st().publishBulletin();
  assert.equal(fail.ok, true);
  assert.equal(b().status, 'failed');
  const ticket = b().publishResult!.ticket;
  assert.equal(b().publishResult!.attempts, 1);
  assert.ok(b().publishResult!.lastError);
  assert.equal(b().publishResult!.approvalSnapshot.length, 2, '审批现场保留');
  assert.equal(b().publishResult!.snapshotParagraphs.length, 5, '待重试内容保留');

  // 失败后事件再变化：通报继续修订，但发布单现场不变
  const r = st().addEvidence({ text: '又有新证据', sensitive: false });
  assert.equal(r.ok, true);
  assert.equal(b().version, 2);
  assert.equal(b().publishResult!.snapshotVersion, 1, '重试仍锁定 v1 内容');

  const retry = st().retryPublish();
  assert.equal(retry.ok, true);
  assert.equal(b().status, 'published');
  assert.equal(b().publishResult!.ticket, ticket, '同一发布单');
  assert.equal(b().publishResult!.attempts, 2, '只累加次数，仍是一条结果');
  assert.equal(b().publishResult!.status, 'success');
  assert.equal(st().incident.timeline.filter((e) => e.text.includes('重试发布成功')).length, 1);

  // 已发布不能再重试
  assert.equal(st().retryPublish().ok, false);
});

test('敏感段落按角色显示（含发布快照）', () => {
  reset('legal');
  st().signBulletin(1);
  st().setRole('responder');
  st().signBulletin(1);
  st().publishBulletin(); // 失败产生快照
  const secret = b().paragraphs.find((p) => p.sensitive)!;
  const pub = b().paragraphs.find((p) => !p.sensitive)!;
  assert.equal(canReadParagraph('viewer', secret), false);
  assert.equal(canReadParagraph('analyst', secret), false);
  assert.equal(canReadParagraph('viewer', pub), true);
  for (const r of COSIGN_ROLES) assert.equal(canReadParagraph(r, secret), true);
  assert.equal(canReadParagraph('pr', secret), true, '公关可看敏感段落');
});

test('只读演示模式冻结所有修订/会签/发布', () => {
  reset('responder');
  st().toggleDemo();
  assert.equal(st().signBulletin(1).ok, false);
  assert.equal(st().addEvidence({ text: 'x', sensitive: false }).ok, false);
  assert.equal(st().addAffectedAsset('z').ok, false);
  assert.equal(st().editBulletinTitle('x').ok, false);
  assert.equal(st().publishBulletin().ok, false);
});
