'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import {
  AlertTriangle, Check, CheckCheck, Eye, FileText, Gavel, History, Lock, PenLine,
  Plus, Radio, RefreshCw, Save, Send, ShieldAlert, UserCheck, Users, X
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  canCountersign, canEditBulletin, seesSensitive, useIncidentStore,
  type BulletinBlock, type BulletinStatus, type IncidentStatus, type ResponseAction, type Role
} from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const roleNames: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务', pr: '公关', viewer: '访客' };
const statusNames: Record<IncidentStatus, string> = { investigating: '调查中', contained: '已遏制', recovered: '已恢复' };
const bulletinStatusNames: Record<BulletinStatus, string> = { draft: '草稿', pending_review: '待审', approved: '已会签', publish_failed: '发布失败', published: '已发布' };

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const canSee = !action.sensitive || ['responder', 'legal'].includes(store.role);
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div><strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong><div className="muted">{action.kind} · 审批人 {action.approvals.join('、') || '无'} · {action.status}</div></div>
      <div className="row-actions">
        <Button size="sm" variant="outline" disabled={store.demoMode || store.role === 'viewer' || action.approvals.includes(store.role)} onClick={() => store.approveAction(action.id)}><UserCheck size={14} />审批</Button>
        <Button size="sm" disabled={store.demoMode || store.role === 'viewer'} onClick={() => store.executeAction(action.id)}>执行</Button>
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

function BulletinCard() {
  const store = useIncidentStore();
  const { role, demoMode } = store;
  const bulletin = store.incident.bulletin;
  const [seenVersions, setSeenVersions] = useState<Partial<Record<Role, number>>>({});
  const [conflict, setConflict] = useState<{ from: number; to: number } | null>(null);
  const [draftBlocks, setDraftBlocks] = useState<BulletinBlock[] | null>(null);
  const [editNote, setEditNote] = useState('');

  const canEdit = canEditBulletin(role) && !demoMode;
  const canSign = canCountersign(role) && !demoMode;
  const seesSens = seesSensitive(role);

  const seenVersion = seenVersions[role] ?? bulletin.currentVersion;
  const markSeen = (v: number) => setSeenVersions((prev) => ({ ...prev, [role]: v }));

  const revision = bulletin.revisions.find((r) => r.version === bulletin.currentVersion)!;
  const blocks = draftBlocks ?? revision.blocks;
  const isStale = seenVersion < bulletin.currentVersion;

  const responderSigned = bulletin.countersigns.some((c) => c.role === 'responder');
  const legalSigned = bulletin.countersigns.some((c) => c.role === 'legal');
  const roleSigned = bulletin.countersigns.some((c) => c.role === role);

  function startEdit() { setDraftBlocks(revision.blocks.map((b) => ({ ...b }))); setEditNote(''); setConflict(null); }
  function saveEdit() {
    if (!draftBlocks) return;
    const nextVersion = bulletin.currentVersion + 1;
    store.editBulletin({ blocks: draftBlocks.filter((b) => b.text.trim()), note: editNote.trim() });
    setDraftBlocks(null);
    markSeen(nextVersion);
    setConflict(null);
  }
  function updateDraft(id: string, patch: Partial<BulletinBlock>) { setDraftBlocks((prev) => (prev ? prev.map((b) => (b.id === id ? { ...b, ...patch } : b)) : prev)); }
  function addBlock() { setDraftBlocks((prev) => [...(prev ?? []), { id: `b-${Date.now()}`, text: '', sensitive: false }]); }
  function removeBlock(id: string) { setDraftBlocks((prev) => (prev ? prev.filter((b) => b.id !== id) : prev)); }
  function doApprove() {
    const result = store.approveBulletin(seenVersion);
    if (result.versionChanged) setConflict({ from: seenVersion, to: result.currentVersion });
    else setConflict(null);
    markSeen(result.currentVersion);
  }

  const canPublish = bulletin.status === 'approved' && !demoMode && role !== 'viewer';
  const canRetry = bulletin.status === 'publish_failed' && !demoMode && role !== 'viewer';
  const publish = bulletin.publish;
  const pending = bulletin.pendingPublish;

  return (
    <Card>
      <CardHeader>
        <div>
          <h2><FileText size={18} className="inline-icon" />{bulletin.title} <Badge className={`status-${bulletin.status}`}>{bulletinStatusNames[bulletin.status]}</Badge></h2>
          <p className="muted">当前版本 v{bulletin.currentVersion} · 影响范围或处置状态变化后原批准失效，通报退回待审</p>
        </div>
        <Badge className="version-badge">v{bulletin.currentVersion}</Badge>
      </CardHeader>
      <CardContent>
        {conflict && (
          <div className="conflict-banner" role="alert">
            <AlertTriangle size={15} />
            <span>您提交期间通报已从 <strong>v{conflict.from}</strong> 更新至 <strong>v{conflict.to}</strong>，会签已按最新版本记录。</span>
          </div>
        )}
        {isStale && !conflict && (
          <div className="stale-note">您审阅基于 v{seenVersion}，通报已更新至 v{bulletin.currentVersion}，提交时将按最新版本记录。<button className="sync-btn" onClick={() => markSeen(bulletin.currentVersion)}>同步至 v{bulletin.currentVersion}</button></div>
        )}

        <div className="bulletin-blocks">
          {blocks.map((b) => {
            const hidden = b.sensitive && !seesSens;
            if (draftBlocks) {
              return (
                <div key={b.id} className={b.sensitive ? 'block-editor sensitive' : 'block-editor'}>
                  <textarea value={b.text} rows={2} placeholder="段落内容" onChange={(e) => updateDraft(b.id, { text: e.target.value })} />
                  <div className="block-editor-foot">
                    <label className="sensitive-toggle"><input type="checkbox" checked={b.sensitive} onChange={(e) => updateDraft(b.id, { sensitive: e.target.checked })} /> 敏感段落</label>
                    <Button size="sm" variant="ghost" onClick={() => removeBlock(b.id)}><X size={14} />删除</Button>
                  </div>
                </div>
              );
            }
            return (
              <div key={b.id} className={b.sensitive ? 'bulletin-block sensitive' : 'bulletin-block'}>
                {b.sensitive && <span className="lock-tag"><Lock size={12} />敏感</span>}
                <p>{hidden ? '敏感段落（当前角色不可见）' : b.text}</p>
              </div>
            );
          })}
          {blocks.length === 0 && <p className="muted">暂无段落，点击「修订」开始编写。</p>}
        </div>

        {draftBlocks ? (
          <div className="edit-bar">
            <Input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="修订说明（可选）" className="edit-note" />
            <Button size="sm" onClick={saveEdit} disabled={demoMode}><Save size={14} />保存为 v{bulletin.currentVersion + 1}</Button>
            <Button size="sm" variant="outline" onClick={() => setDraftBlocks(null)}>取消</Button>
            <Button size="sm" variant="ghost" onClick={addBlock}><Plus size={14} />新增段落</Button>
          </div>
        ) : (
          <div className="bulletin-actions">
            {canEdit && <Button size="sm" variant="outline" onClick={startEdit}><PenLine size={14} />修订口径</Button>}
            {canSign && (
              <Button size="sm" variant={roleSigned ? 'outline' : 'default'} disabled={roleSigned} onClick={doApprove}>
                {roleSigned ? <Check size={14} /> : <CheckCheck size={14} />}
                {roleSigned ? '已会签' : '会签'}
              </Button>
            )}
            {canPublish && <Button size="sm" onClick={store.publishBulletin}><Send size={14} />发布</Button>}
            {canRetry && <Button size="sm" variant="danger" onClick={store.retryPublish}><RefreshCw size={14} />重试发布</Button>}
          </div>
        )}

        <div className="countersign-row">
          <span className={responderSigned ? 'sign signed' : 'sign'}><UserCheck size={13} />响应负责人{responderSigned ? '已会签' : '未签'}</span>
          <span className={legalSigned ? 'sign signed' : 'sign'}><Gavel size={13} />法务{legalSigned ? '已会签' : '未签'}</span>
          {bulletin.status === 'publish_failed' && <span className="muted">审批现场已保留，重试无需重新会签。</span>}
        </div>

        {publish && (
          <div className={publish.status === 'succeeded' ? 'publish-result ok' : 'publish-result fail'}>
            <strong>{publish.status === 'succeeded' ? '发布成功' : '发布失败'}</strong>
            <span>版本 v{publish.version} · 尝试 {publish.attempts} 次 · {publish.status === 'succeeded' ? `已于 ${new Date(publish.publishedAt!).toLocaleString('zh-CN')} 发布` : publish.lastError}</span>
          </div>
        )}
        {pending && bulletin.status === 'publish_failed' && (
          <div className="pending-box">
            <AlertTriangle size={14} />
            <div><strong>待重试内容已保留</strong><span>版本 v{pending.version} · 已尝试 {pending.attempts} 次 · {pending.lastError}</span></div>
          </div>
        )}

        <details className="revision-list">
          <summary><History size={13} />修订记录（{bulletin.revisions.length}）</summary>
          {bulletin.revisions.slice().reverse().map((r) => (
            <div key={r.version} className={r.version === bulletin.currentVersion ? 'revision current' : 'revision'}>
              <strong>v{r.version}</strong><span>{roleNames[r.editedBy]} · {r.note} · {formatDistanceToNow(new Date(r.editedAt), { addSuffix: true, locale: zhCN })}</span>
            </div>
          ))}
        </details>
      </CardContent>
    </Card>
  );
}

function ScopeCard() {
  const store = useIncidentStore();
  const { role, demoMode } = store;
  const incident = store.incident;
  const [evidenceTitle, setEvidenceTitle] = useState('');
  const [asset, setAsset] = useState('');
  const [affectedDraft, setAffectedDraft] = useState<string[] | null>(null);
  const affected = affectedDraft ?? incident.affected;
  const dirty = affectedDraft !== null && affectedDraft.join(',') !== incident.affected.join(',');

  function addEvidence() { if (evidenceTitle.trim()) { store.addEvidence({ title: evidenceTitle.trim() }); setEvidenceTitle(''); } }
  function addAsset() { const v = asset.trim(); if (v && !affected.includes(v)) { setAffectedDraft([...affected, v]); setAsset(''); } }
  function removeAsset(a: string) { setAffectedDraft(affected.filter((x) => x !== a)); }

  return (
    <Card>
      <CardHeader><div><h2>证据与范围变更</h2><p className="muted">新证据、影响范围或处置状态变化后，对外通报退回待审</p></div><ShieldAlert size={20} /></CardHeader>
      <CardContent>
        <label>处置阶段
          <select value={incident.status} disabled={demoMode} onChange={(e) => store.updateIncidentStatus(e.target.value as IncidentStatus)}>
            {Object.entries(statusNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label>影响范围
          <div className="chips">
            {affected.map((a) => <span key={a} className="chip">{a}{affectedDraft && <button onClick={() => removeAsset(a)}><X size={12} /></button>}</span>)}
            <input value={asset} onChange={(e) => setAsset(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAsset(); } }} placeholder="新增资产" className="chip-input" />
          </div>
        </label>
        {dirty && <div className="inline-actions"><Button size="sm" onClick={() => store.updateAffected(affected)} disabled={demoMode}><Save size={14} />保存范围变更</Button><Button size="sm" variant="ghost" onClick={() => setAffectedDraft(null)}>取消</Button></div>}
        <label>新证据
          <div className="inline-actions"><Input value={evidenceTitle} onChange={(e) => setEvidenceTitle(e.target.value)} placeholder="例如：发现第二处失陷站点" /><Button size="sm" onClick={addEvidence} disabled={demoMode}><Plus size={14} />追加证据</Button></div>
        </label>
        <div className="evidence-list">
          {incident.evidence.map((ev) => <div key={ev.id} className="evidence-row"><strong>{ev.title}</strong><span className="muted">{roleNames[ev.by as Role] ?? ev.by} · {formatDistanceToNow(new Date(ev.at), { addSuffix: true, locale: zhCN })}</span></div>)}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: async () => ({ connected: true, latency: 42 }), refetchInterval: 10000 });
  useEffect(() => { const timer = window.setInterval(() => { if (!store.demoMode) store.tick(); }, 20000); return () => window.clearInterval(timer); }, [store.demoMode]);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = ['responder', 'legal'].includes(store.role);

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="controls"><select value={store.role} onChange={(event) => store.setRole(event.target.value as Role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button></div></header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、拖拽、修订、会签、发布与新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    <section className="metrics"><Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card><Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : '离线'}</strong><small>{health.connected ? '监测代理已连接' : '等待连接'}</small></CardContent></Card><Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card><Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/总数</small></CardContent></Card></section>
    <section className="grid">
      <div className="stack">
        <Card><CardHeader><div><h2>事件摘要</h2><p className="muted">影响范围：{incident.affected.join(' · ')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader><CardContent><div className="incident-state"><span>处置阶段</span><strong>{statusNames[incident.status]}</strong></div><h3>子事件</h3>{incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}</CardContent></Card>
        <BulletinCard />
        <Card><CardHeader><div><h2>{t('approval')}</h2><p className="muted">隔离动作需两名不同角色确认，敏感动作仅响应和法务角色可见。</p></div><Users size={20} /></CardHeader><CardContent><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div></SortableContext></DndContext></CardContent></Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={store.demoMode}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <ScopeCard />
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">每 20 秒接收一次模拟监测事件</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}</div></CardContent></Card>
      </div>
    </section>
  </main>;
}
