'use client';
import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  AlertTriangle, CheckCircle2, FileText, Gavel, History, Lock, Megaphone,
  RefreshCw, Send, ShieldCheck, XCircle
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  canEditBulletin, canReadParagraph, COSIGN_ROLES, useIncidentStore,
  type ApprovalRecord, type Bulletin, type OpResult
} from '@/lib/store';
import { roleLabels, type Role } from '@/lib/roles';

const bulletinStatusMeta: Record<Bulletin['status'], { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'st-draft' },
  pending: { label: '待审', cls: 'st-pending' },
  approved: { label: '已批准·待发布', cls: 'st-approved' },
  publishing: { label: '发布中', cls: 'st-publishing' },
  published: { label: '已发布', cls: 'st-published' },
  failed: { label: '发布失败·待重试', cls: 'st-failed' }
};
const incidentStatusLabels = { investigating: '调查中', contained: '已遏制', recovered: '已恢复' } as const;

function Feedback({ result }: { result: OpResult | null }) {
  if (!result) return null;
  return <div className={`op-feedback ${result.ok ? 'fb-ok' : 'fb-err'}`}>
    {result.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}{result.message}
  </div>;
}

/** 段落行：敏感段落按角色显示；法务/公关可就地改口径（保存即出新版本） */
function ParagraphRow({ paragraph, index, revision, onEdited }: {
  paragraph: Bulletin['paragraphs'][number]; index: number; revision: number;
  onEdited: (r: OpResult) => void;
}) {
  const store = useIncidentStore();
  const role = store.role;
  const visible = canReadParagraph(role, paragraph);
  const editable = canEditBulletin(role) && !store.demoMode;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(paragraph.body);
  // 通报被修订（他人改口径 / 事件联动）后，退出编辑并取最新内容
  useEffect(() => { setDraft(paragraph.body); setEditing(false); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) {
    return <div className="para para-hidden">
      <div className="para-head"><Lock size={13} /><span className="para-title">{paragraph.title}</span><Badge className="badge-secret">敏感 · 当前角色不可见</Badge></div>
      <p className="para-body masked">████████████████ 该段落仅响应负责人 / 法务 / 公关可见</p>
    </div>;
  }

  return <div className="para">
    <div className="para-head">
      <span className="para-index">#{index + 1}</span>
      <span className="para-title">{paragraph.title}</span>
      {paragraph.sensitive && <Badge className="badge-secret">敏感段落</Badge>}
      {editable && !editing && <Button size="sm" variant="ghost" onClick={() => { setDraft(paragraph.body); setEditing(true); }}>改口径</Button>}
    </div>
    {editing ? (
      <div className="para-edit">
        <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="para-edit-actions">
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(paragraph.body); }}>取消</Button>
          <Button size="sm" onClick={() => { onEdited(store.editBulletinParagraph(paragraph.id, draft)); setEditing(false); }}><Send size={13} />保存为新版本</Button>
        </div>
      </div>
    ) : <p className="para-body">{paragraph.body}</p>}
  </div>;
}

/** 会签面板：两角色去重确认；乐观锁检测“后到一方看到版本变化” */
function SignPanel({ viewedVersion, bumpViewed, onResult }: {
  viewedVersion: number; bumpViewed: () => void; onResult: (r: OpResult) => void;
}) {
  const store = useIncidentStore();
  const b = store.incident.bulletin;
  const active = b.approvals.filter((a) => a.status === 'active');
  const signedRoles = new Set(active.map((a) => a.role));
  const stale = viewedVersion !== b.version;

  return <div className="sign-panel">
    <div className="sign-slots">
      {COSIGN_ROLES.map((r) => {
        const rec = active.find((a) => a.role === r);
        return <div key={r} className={`sign-slot ${rec ? 'signed' : ''}`}>
          <div className="slot-head">{r === 'responder' ? <ShieldCheck size={15} /> : <Gavel size={15} />}<strong>{roleLabels[r]}</strong></div>
          {rec
            ? <div className="slot-signed"><CheckCircle2 size={13} /> 已会签 v{rec.version}<span className="slot-time">{format(new Date(rec.at), 'HH:mm:ss')}</span></div>
            : <div className="slot-wait">待确认</div>}
        </div>;
      })}
    </div>
    {stale && b.status !== 'published' && (
      <div className="stale-banner">
        <AlertTriangle size={14} />
        <span>版本已变化：你正在查看 v{viewedVersion}，当前最新为 v{b.version}（{b.updatedBy} 更新）。请先同步最新版本再确认——后到一方的旧版本会签将被拒绝。</span>
        <Button size="sm" variant="outline" onClick={bumpViewed}>查看最新 v{b.version}</Button>
      </div>
    )}
    <div className="sign-action">
      <Button size="sm" disabled={store.demoMode || store.role === 'viewer' || store.role === 'analyst' || store.role === 'pr' || stale || b.status === 'published'}
        onClick={() => onResult(store.signBulletin(viewedVersion))}>
        <Gavel size={14} />以「{roleLabels[store.role]}」会签确认（基于 v{viewedVersion}）
      </Button>
      <span className="sign-hint">同一角色重复确认只算一次；两个角色同时提交时，后到一方若版本已变会收到冲突提示。</span>
    </div>
  </div>;
}

/** 发布面板：失败保留待重试内容与审批现场，重试只生成一条发布结果 */
function PublishPanel({ viewedVersion, bumpViewed, onResult }: {
  viewedVersion: number; bumpViewed: () => void; onResult: (r: OpResult) => void;
}) {
  const store = useIncidentStore();
  const b = store.incident.bulletin;
  const r = b.publishResult;
  const canPublish = ['responder', 'legal', 'pr'].includes(store.role) && !store.demoMode;

  return <div className="publish-panel">
    {!r && b.status !== 'approved' && <p className="muted">完成响应负责人 + 法务双角色会签后，方可对外发布。</p>}

    {b.status === 'approved' && (
      <div className="publish-ready">
        <ShieldCheck size={16} /> v{b.version} 已批准，待发布内容与审批现场已锁定。
        <Button size="sm" disabled={!canPublish} onClick={() => onResult(store.publishBulletin())}><Megaphone size={14} />发布对外通报</Button>
      </div>
    )}

    {r && (
      <div className={`publish-result pr-${r.status}`}>
        <div className="pr-head">
          {r.status === 'failure' ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
          <strong>发布单 {r.ticket}</strong>
          <Badge className={r.status === 'failure' ? 'st-failed' : 'st-published'}>{r.status === 'failure' ? '失败·待重试' : '发布成功'}</Badge>
          <span className="pr-attempts">尝试 {r.attempts} 次（同一条结果）</span>
        </div>
        <div className="pr-meta">渠道：{r.channel}{r.lastError ? ` · 错误：${r.lastError}` : ''}{r.publishedAt ? ` · 发布时间：${format(new Date(r.publishedAt), 'MM-dd HH:mm:ss')}` : ''}</div>

        {r.status === 'failure' && (
          <div className="retry-row">
            <Button size="sm" disabled={!canPublish} onClick={() => onResult(store.retryPublish())}><RefreshCw size={14} />重试发布</Button>
            <span className="muted">待重试内容与审批现场保留；事件再有变化时通报会继续修订，重试仍按本单锁定的 v{r.snapshotVersion} 会签内容发布。</span>
          </div>
        )}

        {/* 待重试内容快照：敏感段落仍按角色遮蔽 */}
        <div className="snapshot">
          <div className="snapshot-title"><FileText size={13} />锁定内容快照 v{r.snapshotVersion}：{r.snapshotTitle}</div>
          {r.snapshotParagraphs.map((p) =>
            canReadParagraph(store.role, p)
              ? <p key={p.id} className="snap-para"><span>{p.title}</span>{p.body}</p>
              : <p key={p.id} className="snap-para masked"><span>{p.title}</span>████████ 敏感段落（当前角色不可见）</p>
          )}
          <div className="snapshot-approvals">
            <span>审批现场：</span>
            {r.approvalSnapshot.length === 0 && <em>无</em>}
            {r.approvalSnapshot.map((a) => <Badge key={a.id} className="badge-approval">{roleLabels[a.role]} v{a.version}</Badge>)}
          </div>
        </div>
      </div>
    )}

    {viewedVersion !== b.version && b.status !== 'published' && (
      <div className="stale-banner compact">
        <AlertTriangle size={13} /><span>通报已被修订至 v{b.version}，你仍在查看 v{viewedVersion}。</span>
        <Button size="sm" variant="ghost" onClick={bumpViewed}>同步</Button>
      </div>
    )}
  </div>;
}

function ApprovalLog() {
  const b = useIncidentStore((s) => s.incident.bulletin);
  const all = [...b.approvals].sort((x, y) => +new Date(y.at) - +new Date(x.at));
  return <div className="approval-log">
    {all.length === 0 && <p className="muted">暂无审批记录。原批准失效后记录仍会保留并标注原因。</p>}
    {all.map((a: ApprovalRecord) => (
      <div key={a.id} className={`ap-row ${a.status}`}>
        <div className="ap-head">
          {a.status === 'active' ? <CheckCircle2 size={13} className="ap-ic-ok" /> : <XCircle size={13} className="ap-ic-bad" />}
          <strong>{roleLabels[a.role as Role]}</strong>
          <span className="ap-ver">会签 v{a.version}</span>
          <Badge className={a.status === 'active' ? 'st-approved' : 'st-failed'}>{a.status === 'active' ? '生效中' : '已失效'}</Badge>
          <span className="ap-time">{format(new Date(a.at), 'MM-dd HH:mm:ss')}</span>
        </div>
        {a.invalidReason && <div className="ap-reason">失效原因：{a.invalidReason} —— 该批准不再用于发布</div>}
      </div>
    ))}
  </div>;
}

/** 主事件联动：新证据 / 影响范围 / 处置状态变化都会触发修订并使旧批准失效 */
function RevisionControls({ onResult }: { onResult: (r: OpResult) => void }) {
  const store = useIncidentStore();
  const incident = store.incident;
  const [evidence, setEvidence] = useState('');
  const [sensitive, setSensitive] = useState(true);
  const [asset, setAsset] = useState('');

  return <div className="revision-controls">
    <div className="rc-block">
      <label className="rc-label">新证据（写入时间线，旧批准立即失效）</label>
      <Textarea rows={2} placeholder="例如：溯源发现第二个跳板主机 web-tunnel-07" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      <label className="rc-check"><input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />标记为敏感证据（按角色显示）</label>
      <Button size="sm" disabled={store.demoMode} onClick={() => { const r = store.addEvidence({ text: evidence, sensitive }); onResult(r); if (r.ok) setEvidence(''); }}>
        <History size={13} />提交新证据并触发修订
      </Button>
    </div>
    <div className="rc-block">
      <label className="rc-label">影响范围：新增受影响资产</label>
      <div className="rc-inline">
        <Input value={asset} placeholder="例如：billing-service" onChange={(e) => setAsset(e.target.value)} />
        <Button size="sm" variant="outline" disabled={store.demoMode} onClick={() => { const r = store.addAffectedAsset(asset); onResult(r); if (r.ok) setAsset(''); }}>加入影响范围</Button>
      </div>
      <div className="asset-list">{incident.affected.map((a) => <Badge key={a} className="badge-asset">{a}</Badge>)}</div>
    </div>
    <div className="rc-block">
      <label className="rc-label">处置状态（仅响应负责人）</label>
      <div className="rc-inline">
        <select className="rc-select" value={incident.status} disabled={store.demoMode || store.role !== 'responder'}
          onChange={(e) => onResult(store.updateIncidentStatus(e.target.value as typeof incident.status))}>
          {Object.entries(incidentStatusLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="muted">状态变化后通报退回待审</span>
      </div>
    </div>
  </div>;
}

export function BulletinBoard() {
  const store = useIncidentStore();
  const b = store.incident.bulletin;
  // 当前用户“所看版本”：初次加载与本人操作成功后跟随最新；他人改出新版时冻结，由用户手动同步，
  // 从而模拟“两个角色同时提交，后到一方看到版本变化”。
  const [viewedVersion, setViewedVersion] = useState(b.version);
  const [feedback, setFeedback] = useState<OpResult | null>(null);
  useEffect(() => { setViewedVersion(b.version); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 6000);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const report = (r: OpResult) => {
    setFeedback(r);
    if (r.ok) setViewedVersion(useIncidentStore.getState().incident.bulletin.version);
  };
  const meta = bulletinStatusMeta[b.status];
  const editable = canEditBulletin(store.role) && !store.demoMode;
  const [titleDraft, setTitleDraft] = useState(b.title);
  useEffect(() => { setTitleDraft(b.title); }, [b.title]);

  return <section className="bulletin-wrap">
    <Card>
      <CardHeader>
        <div>
          <h2><Megaphone size={18} /> 对外通报修订与会签发布</h2>
          <p className="muted">主事件 · 对外通报 · 审批记录 · 事件时间线 联动：影响范围或处置状态变化后，原批准失效、通报退回待审。</p>
        </div>
        <div className="bulletin-ver">
          <Badge className={meta.cls}>{meta.label}</Badge>
          <span className="ver-num">v{b.version}</span>
          <span className="muted">最近更新：{b.updatedBy} · {format(new Date(b.updatedAt), 'MM-dd HH:mm:ss')}</span>
        </div>
      </CardHeader>
      <CardContent>
        <Feedback result={feedback} />
        <div className="bulletin-grid">
          <div className="bulletin-col">
            <div className="col-title"><FileText size={15} /> 通报内容（法务 / 公关各自改口径）</div>
            <div className="title-edit">
              <Input value={editable ? titleDraft : b.title} readOnly={!editable} onChange={(e) => setTitleDraft(e.target.value)} />
              {editable && <Button size="sm" variant="outline" disabled={titleDraft.trim() === b.title}
                onClick={() => report(store.editBulletinTitle(titleDraft))}>保存标题</Button>}
            </div>
            {b.paragraphs.map((p, i) => <ParagraphRow key={p.id} paragraph={p} index={i} revision={b.revision} onEdited={report} />)}
            <div className="rev-note">
              <History size={13} />
              每次保存口径 / 事件联动修订都会使版本号 +1，并让当前版本所有生效批准失效。
              {b.history.length > 0 && <div className="rev-history">
                最近修订：{b.history.slice(0, 3).map((h) => `v${h.version} ${h.note}（${h.actor}）`).join('；')}
              </div>}
            </div>
          </div>

          <div className="bulletin-col">
            <div className="col-title"><ShieldCheck size={15} /> 双角色会签（响应负责人 + 法务）</div>
            <SignPanel viewedVersion={viewedVersion} bumpViewed={() => setViewedVersion(b.version)} onResult={report} />

            <div className="col-title mt"><Megaphone size={15} /> 发布与重试</div>
            <PublishPanel viewedVersion={viewedVersion} bumpViewed={() => setViewedVersion(b.version)} onResult={report} />

            <div className="col-title mt"><History size={15} /> 审批记录（含已失效批准）</div>
            <ApprovalLog />

            <div className="col-title mt"><AlertTriangle size={15} /> 事件联动修订入口</div>
            <RevisionControls onResult={report} />
          </div>
        </div>
      </CardContent>
    </Card>
  </section>;
}
