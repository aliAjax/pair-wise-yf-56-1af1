import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Role = 'analyst' | 'responder' | 'legal' | 'pr' | 'viewer';
export type Severity = 'medium' | 'high' | 'critical';
export type IncidentStatus = 'investigating' | 'contained' | 'recovered';

export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface ResponseAction { id: string; title: string; kind: 'isolate' | 'block' | 'restore' | 'notify'; approvals: string[]; status: 'pending' | 'approved' | 'executed'; sensitive?: boolean; }

export interface Evidence { id: string; title: string; at: string; by: string; }

// 对外通报（修订流程）
export type BulletinStatus = 'draft' | 'pending_review' | 'approved' | 'publish_failed' | 'published';
export interface BulletinBlock { id: string; text: string; sensitive: boolean; }
export interface BulletinRevision { version: number; blocks: BulletinBlock[]; editedBy: Role; editedAt: string; note: string; }
export interface Countersign { id: string; version: number; role: 'responder' | 'legal'; at: string; }
export interface PublishResult { version: number; status: 'succeeded' | 'failed'; attempts: number; lastError?: string; publishedAt?: string; }
export interface PendingPublish { version: number; blocks: BulletinBlock[]; attempts: number; lastError: string; failedAt: string; }
export interface Bulletin {
  id: string;
  title: string;
  currentVersion: number;
  revisions: BulletinRevision[];
  countersigns: Countersign[];
  publish: PublishResult | null;
  pendingPublish: PendingPublish | null;
  status: BulletinStatus;
}

export interface Incident {
  id: string; title: string; severity: Severity; status: IncidentStatus; affected: string[];
  subIncidents: SubIncident[]; actions: ResponseAction[]; timeline: TimelineEvent[];
  evidence: Evidence[];
  bulletin: Bulletin;
}

export interface ApproveBulletinResult { versionChanged: boolean; currentVersion: number; alreadySigned: boolean; }

interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  reorderActions: (activeId: string, overId: string) => void;
  tick: () => void;
  editBulletin: (payload: { blocks: BulletinBlock[]; note: string }) => void;
  approveBulletin: (seenVersion: number) => ApproveBulletinResult;
  publishBulletin: () => void;
  retryPublish: () => void;
  addEvidence: (payload: { title: string }) => void;
  updateAffected: (affected: string[]) => void;
  updateIncidentStatus: (status: IncidentStatus) => void;
}

export const canEditBulletin = (role: Role): boolean => role === 'legal' || role === 'pr' || role === 'responder';
export function canCountersign(role: Role): role is 'responder' | 'legal' { return role === 'responder' || role === 'legal'; }
export const seesSensitive = (role: Role): boolean => role === 'responder' || role === 'legal';

let seq = 0;
function uid(prefix: string): string { seq += 1; return `${prefix}-${Date.now().toString(36)}-${seq}`; }
function nowIso(): string { return new Date().toISOString(); }
function pushTimeline(timeline: TimelineEvent[], event: TimelineEvent): TimelineEvent[] { return [event, ...timeline].slice(0, 50); }
function timelineEvent(actor: string, text: string, sensitive = false): TimelineEvent { return { id: uid('e'), at: nowIso(), actor, text, sensitive }; }

// 影响范围 / 处置状态 / 证据变化后，原批准失效、通报退回待审
function invalidateBulletin(bulletin: Bulletin): Bulletin {
  return { ...bulletin, countersigns: [], status: 'pending_review' };
}

const initialBulletin: Bulletin = {
  id: 'bul-1',
  title: '对外通报',
  currentVersion: 1,
  revisions: [
    {
      version: 1,
      editedBy: 'legal',
      editedAt: nowIso(),
      note: '初始口径',
      blocks: [
        { id: 'b1', text: '我们监测到一起针对对外网关的异常凭证使用事件，已启动应急预案并成立专项组。', sensitive: false },
        { id: 'b2', text: '经初步核查，目前未发现客户数据泄露，客户业务运行正常。', sensitive: false },
        { id: 'b3', text: '涉事凭证的补发与客户赔偿方案正在法务评估中，暂不对外披露。', sensitive: true }
      ]
    }
  ],
  countersigns: [],
  publish: null,
  pendingPublish: null,
  status: 'pending_review'
};

const initial: Incident = {
  id: 'INC-2026-0929',
  title: '对外网关异常凭证使用',
  severity: 'critical',
  status: 'investigating',
  affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: ['analyst'], status: 'pending', sensitive: true },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending' },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'pending', sensitive: true }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ],
  evidence: [
    { id: 'ev-1', title: '异常登录 IP 与凭证使用记录', at: new Date(Date.now() - 1200000).toISOString(), by: '分析组' }
  ],
  bulletin: initialBulletin
};

// 发布执行：首次必然失败（模拟网关超时），重试成功；多次尝试只写一条发布结果
function runPublish(incident: Incident, role: Role, attempts: number): { bulletin: Bulletin; timeline: TimelineEvent[] } {
  const bulletin = incident.bulletin;
  const revision = bulletin.revisions.find((r) => r.version === bulletin.currentVersion);
  if (attempts === 1) {
    const lastError = '发布网关超时（504）';
    const pendingPublish: PendingPublish = { version: bulletin.currentVersion, blocks: revision?.blocks ?? [], attempts, lastError, failedAt: nowIso() };
    const publish: PublishResult = { version: bulletin.currentVersion, status: 'failed', attempts, lastError };
    return {
      bulletin: { ...bulletin, publish, pendingPublish, status: 'publish_failed' },
      timeline: pushTimeline(incident.timeline, timelineEvent(role, `对外通报 v${bulletin.currentVersion} 发布失败：${lastError}，已保留待重试内容与审批现场`, true))
    };
  }
  const publish: PublishResult = { version: bulletin.currentVersion, status: 'succeeded', attempts, publishedAt: nowIso() };
  return {
    bulletin: { ...bulletin, publish, pendingPublish: null, status: 'published' },
    timeline: pushTimeline(incident.timeline, timelineEvent(role, `对外通报 v${bulletin.currentVersion} 发布成功（共 ${attempts} 次尝试，仅生成一条发布结果）`, true))
  };
}

export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial,
  role: 'analyst',
  demoMode: false,
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  addSubIncident: (payload) => {
    if (get().demoMode) return;
    set((state) => ({ incident: { ...state.incident, subIncidents: [...state.incident.subIncidents, { id: uid('sub'), ...payload, status: 'open' }], timeline: pushTimeline(state.incident.timeline, timelineEvent('响应负责人', `创建子事件：${payload.title}`)) } }));
  },
  approveAction: (id) => {
    const state = get();
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || action.approvals.includes(state.role) || state.role === 'viewer' || state.demoMode) return;
    const actions = state.incident.actions.map((item) => {
      if (item.id !== id) return item;
      const approvals = [...item.approvals, state.role];
      const status = item.kind === 'isolate' && approvals.length >= 2 ? 'approved' : item.status;
      return { ...item, approvals, status };
    });
    set({ incident: { ...state.incident, actions, timeline: pushTimeline(state.incident.timeline, timelineEvent(state.role, `审批处置动作：${action.title}`)) } });
  },
  executeAction: (id) => {
    const state = get();
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action || state.demoMode || state.role === 'viewer' || (action.kind === 'isolate' && action.approvals.length < 2)) return;
    const actions = state.incident.actions.map((item) => (item.id === id ? { ...item, status: 'executed' as const } : item));
    set({ incident: { ...state.incident, actions, timeline: pushTimeline(state.incident.timeline, timelineEvent(state.role, `执行处置动作：${action.title}`, action.sensitive)) } });
  },
  reorderActions: (activeId, overId) => {
    const state = get();
    const actions = [...state.incident.actions];
    const from = actions.findIndex((item) => item.id === activeId);
    const to = actions.findIndex((item) => item.id === overId);
    if (from < 0 || to < 0 || state.demoMode) return;
    const [moved] = actions.splice(from, 1);
    actions.splice(to, 0, moved);
    set({ incident: { ...state.incident, actions } });
  },
  tick: () => set((state) => ({ incident: { ...state.incident, timeline: pushTimeline(state.incident.timeline, timelineEvent('监测代理', `实时检查：${state.incident.affected.length} 项资产状态已更新`)) } })),

  // 修订流程：法务 / 公关 / 响应负责人各自改口径，生成新版本
  editBulletin: (payload) => {
    const state = get();
    if (state.demoMode || !canEditBulletin(state.role)) return;
    set((s) => {
      const bulletin = s.incident.bulletin;
      const nextVersion = bulletin.currentVersion + 1;
      const revision: BulletinRevision = { version: nextVersion, blocks: payload.blocks, editedBy: s.role, editedAt: nowIso(), note: payload.note || '修订对外口径' };
      return {
        incident: {
          ...s.incident,
          bulletin: { ...bulletin, currentVersion: nextVersion, revisions: [...bulletin.revisions, revision], countersigns: [], publish: null, pendingPublish: null, status: 'pending_review' },
          timeline: pushTimeline(s.incident.timeline, timelineEvent(s.role, `修订对外通报至 v${nextVersion}：${revision.note}`))
        }
      };
    });
  },

  // 会签：响应负责人 + 法务；同一角色重复确认只算一次；后到一方看到版本变化
  approveBulletin: (seenVersion) => {
    const state = get();
    const currentVersion = state.incident.bulletin.currentVersion;
    if (state.demoMode || !canCountersign(state.role)) return { versionChanged: false, currentVersion, alreadySigned: false };
    const bulletin = state.incident.bulletin;
    const versionChanged = seenVersion < currentVersion;
    const alreadySigned = bulletin.countersigns.some((c) => c.role === state.role && c.version === currentVersion);
    if (alreadySigned) return { versionChanged, currentVersion, alreadySigned: true };
    const countersign: Countersign = { id: uid('cs'), version: currentVersion, role: state.role, at: nowIso() };
    const countersigns = [...bulletin.countersigns.filter((c) => c.role !== state.role), countersign];
    const approved = countersigns.some((c) => c.role === 'responder') && countersigns.some((c) => c.role === 'legal');
    set({
      incident: {
        ...state.incident,
        bulletin: { ...bulletin, countersigns, status: approved ? 'approved' : 'pending_review' },
        timeline: pushTimeline(state.incident.timeline, timelineEvent(state.role, `会签对外通报 v${currentVersion}${versionChanged ? '（审阅期间版本已更新，按最新版本记录）' : ''}`))
      }
    });
    return { versionChanged, currentVersion, alreadySigned: false };
  },

  publishBulletin: () => {
    const state = get();
    const bulletin = state.incident.bulletin;
    if (state.demoMode || state.role === 'viewer' || bulletin.status !== 'approved') return;
    const attempts = (bulletin.pendingPublish?.attempts ?? 0) + 1;
    const { bulletin: next, timeline } = runPublish(state.incident, state.role, attempts);
    set({ incident: { ...state.incident, bulletin: next, timeline } });
  },
  retryPublish: () => {
    const state = get();
    const bulletin = state.incident.bulletin;
    if (state.demoMode || state.role === 'viewer' || bulletin.status !== 'publish_failed' || !bulletin.pendingPublish) return;
    const attempts = bulletin.pendingPublish.attempts + 1;
    const { bulletin: next, timeline } = runPublish(state.incident, state.role, attempts);
    set({ incident: { ...state.incident, bulletin: next, timeline } });
  },

  addEvidence: (payload) => {
    const state = get();
    if (state.demoMode) return;
    set((s) => {
      const evidence: Evidence = { id: uid('ev'), title: payload.title, at: nowIso(), by: s.role };
      return {
        incident: {
          ...s.incident,
          evidence: [evidence, ...s.incident.evidence],
          bulletin: invalidateBulletin(s.incident.bulletin),
          timeline: pushTimeline(s.incident.timeline, timelineEvent(s.role, `收到新证据：${payload.title}，对外通报退回待审`))
        }
      };
    });
  },
  updateAffected: (affected) => {
    const state = get();
    if (state.demoMode) return;
    set((s) => {
      if (affected.join(',') === s.incident.affected.join(',')) return s;
      return {
        incident: {
          ...s.incident,
          affected,
          bulletin: invalidateBulletin(s.incident.bulletin),
          timeline: pushTimeline(s.incident.timeline, timelineEvent(s.role, `影响范围变更为 ${affected.join('、')}，对外通报退回待审`))
        }
      };
    });
  },
  updateIncidentStatus: (status) => {
    const state = get();
    if (state.demoMode) return;
    set((s) => {
      if (s.incident.status === status) return s;
      return {
        incident: {
          ...s.incident,
          status,
          bulletin: invalidateBulletin(s.incident.bulletin),
          timeline: pushTimeline(s.incident.timeline, timelineEvent(s.role, `处置状态变更为 ${status}，对外通报退回待审`))
        }
      };
    });
  }
}), { name: 'yf56-incident-store-v2' }));
