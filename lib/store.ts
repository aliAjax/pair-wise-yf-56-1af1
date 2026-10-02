import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Role } from './roles';

export type Severity = 'medium' | 'high' | 'critical';
export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface ResponseAction { id: string; title: string; kind: 'isolate' | 'block' | 'restore' | 'notify'; approvals: string[]; status: 'pending' | 'approved' | 'executed'; sensitive?: boolean; }

/** 对外通报：敏感段落按角色显示 */
export interface BulletinParagraph { id: string; key: string; title: string; body: string; sensitive?: boolean; }
/** 审批记录：按角色去重（同一角色重复确认只算一次），记录所看版本以支持乐观锁 */
export interface ApprovalRecord {
  id: string; at: string; role: Role; actor: string;
  version: number; baseVersion: number;
  status: 'active' | 'invalidated';
  invalidReason?: string;
}
/** 发布结果：一条发布单贯穿“失败保留 + 重试”，重试只生成一条结果 */
export interface PublishResult {
  ticket: string; attempts: number;
  status: 'publishing' | 'success' | 'failure';
  channel: string; lastError?: string;
  publishedAt?: string;
  /** 审批现场快照：发布时已生效的会签记录 */
  approvalSnapshot: ApprovalRecord[];
  /** 待重试内容快照：失败后通报可继续被修订，重试仍按原批准内容发布 */
  snapshotVersion: number;
  snapshotTitle: string;
  snapshotParagraphs: BulletinParagraph[];
}
export interface Bulletin {
  version: number;
  status: 'draft' | 'pending' | 'approved' | 'publishing' | 'published' | 'failed';
  title: string;
  paragraphs: BulletinParagraph[];
  approvals: ApprovalRecord[];
  /** 当前发布单；版本进入新一轮后仍保留作为现场，新发版另开单号 */
  publishResult?: PublishResult;
  updatedAt: string;
  updatedBy: string;
  /** 每次联动/口径修订自增，供 UI 重置编辑态 */
  revision: number;
  history: { at: string; actor: string; version: number; note: string }[];
}
export interface Incident {
  id: string; title: string; severity: Severity; status: 'investigating' | 'contained' | 'recovered'; affected: string[];
  subIncidents: SubIncident[]; actions: ResponseAction[]; timeline: TimelineEvent[];
  bulletin: Bulletin;
}

export interface OpResult { ok: boolean; message: string; }
interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => OpResult;
  approveAction: (id: string) => OpResult;
  executeAction: (id: string) => OpResult;
  reorderActions: (activeId: string, overId: string) => void;
  tick: () => void;
  // —— 修订流程 ——
  addEvidence: (payload: { text: string; sensitive: boolean }) => OpResult;
  addAffectedAsset: (asset: string) => OpResult;
  updateIncidentStatus: (status: Incident['status']) => OpResult;
  editBulletinTitle: (title: string) => OpResult;
  editBulletinParagraph: (id: string, body: string) => OpResult;
  signBulletin: (baseVersion: number) => OpResult;
  publishBulletin: () => OpResult;
  retryPublish: () => OpResult;
  resetDemo: () => void;
}

let seq = 0;
const uid = (prefix: string) => {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
};
const nowIso = () => new Date().toISOString();
const roleActors: Record<Role, string> = {
  analyst: '值班分析员', responder: '响应负责人', legal: '法务', pr: '公关', viewer: '访客'
};
/** 会签需两个角色同时确认：响应负责人 + 法务 */
export const COSIGN_ROLES: Role[] = ['responder', 'legal'];

const initialBulletin: Bulletin = {
  version: 1,
  status: 'draft',
  title: '关于对外网关异常凭证使用的初步通报（草稿）',
  paragraphs: [
    { id: 'p-1', key: 'overview', title: '事件概述', body: '我司监测到对外网关出现异常凭证使用，安全团队已介入处置，目前业务运行总体平稳。', sensitive: false },
    { id: 'p-2', key: 'impact', title: '影响范围', body: '正在核实受影响的服务与租户范围，确认后将第一时间更新。', sensitive: false },
    { id: 'p-3', key: 'action', title: '处置措施', body: '已启动应急响应，对异常会话进行阻断，并对相关凭据启动轮换。', sensitive: false },
    { id: 'p-4', key: 'ioc', title: '技术细节（IOC）', body: '异常来源跨三个地域登录，命中审计日志 api-gateway / customer-portal / audit-log 三条链路。', sensitive: true },
    { id: 'p-5', key: 'liability', title: '法律口径', body: '在监管报送完成前，不主动评论责任归属，相关问询统一转法务接口人。', sensitive: true }
  ],
  approvals: [],
  updatedAt: nowIso(),
  updatedBy: '公关',
  revision: 0,
  history: []
};

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
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
  bulletin: initialBulletin
};

const denied = (message: string): OpResult => ({ ok: false, message });
const ok = (message: string): OpResult => ({ ok: true, message });

/**
 * 影响范围或处置状态变化后：原批准失效，通报退回待审。
 * 已失效记录保留并标注原因（审批现场不丢），版本号 +1。
 */
function reviseBulletin(b: Bulletin, note: string, actor: string): Bulletin {
  const at = nowIso();
  const approvals: ApprovalRecord[] = b.approvals.map((a) =>
    a.status === 'active'
      ? { ...a, status: 'invalidated', invalidReason: `v${b.version + 1} ${note}` }
      : a
  );
  return {
    ...b,
    version: b.version + 1,
    // 草稿保持草稿；失败待重试保持失败（发布单现场保留可重试，发布内容以快照为准）；其余退回待审
    status: b.status === 'draft' ? 'draft' : b.status === 'failed' ? 'failed' : 'pending',
    approvals,
    updatedAt: at,
    updatedBy: actor,
    revision: b.revision + 1,
    history: [{ at, actor, version: b.version + 1, note }, ...b.history]
  };
}

function timelineEntry(actor: string, text: string, sensitive?: boolean): TimelineEvent {
  return { id: uid('e'), at: nowIso(), actor, text, sensitive };
}

/** 敏感段落可见性：法务/公关可改可看全部；响应负责人可见；分析员/访客只见公开段落 */
export function canReadParagraph(role: Role, p: BulletinParagraph) {
  return !p.sensitive || role === 'responder' || role === 'legal' || role === 'pr';
}
export function canEditBulletin(role: Role) {
  return role === 'legal' || role === 'pr';
}

function activeApprovals(b: Bulletin) {
  return b.approvals.filter((a) => a.status === 'active');
}
function cosignReady(b: Bulletin) {
  const roles = new Set(activeApprovals(b).map((a) => a.role));
  return COSIGN_ROLES.every((r) => roles.has(r));
}

export const useIncidentStore = create<State>()(persist((set, get) => {
  /** 修订通报：版本 +1、旧批准失效，并在时间线留痕（事件驱动） */
  const applyRevision = (state: State, note: string, actor: string, sensitiveEntry?: boolean, entryText?: string) => {
    const before = state.incident.bulletin.version;
    const bulletin = reviseBulletin(state.incident.bulletin, note, actor);
    const outcome = bulletin.status === 'failed'
      ? '待重试发布单与审批现场保留，重试按已锁定快照发布'
      : '通报退回待审';
    const entries: TimelineEvent[] = [
      timelineEntry(actor, entryText ?? `事件信息变化（${note}），通报修订至 v${bulletin.version}`, sensitiveEntry),
      timelineEntry('审批引擎', `影响范围/处置状态变化：v${before} 的原批准失效，${outcome}`)
    ];
    return { ...state.incident, bulletin, timeline: [...entries, ...state.incident.timeline] };
  };

  return {
    incident: initial, role: 'analyst', demoMode: false,
    setRole: (role) => set({ role }),
    toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),

    addSubIncident: (payload) => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启，无法新增子事件');
      set({
        incident: {
          ...state.incident,
          subIncidents: [...state.incident.subIncidents, { id: uid('sub'), ...payload, status: 'open' }],
          timeline: [timelineEntry(roleActors[state.role], `创建子事件：${payload.title}`), ...state.incident.timeline]
        }
      });
      return ok('子事件已创建');
    },

    approveAction: (id) => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      if (state.role === 'viewer') return denied('访客无权审批');
      const action = state.incident.actions.find((item) => item.id === id);
      if (!action) return denied('动作不存在');
      if (action.approvals.includes(state.role)) return denied('该角色已确认，无需重复审批');
      set({
        incident: {
          ...state.incident,
          actions: state.incident.actions.map((item) =>
            item.id === id
              ? { ...item, approvals: [...item.approvals, state.role], status: item.approvals.length >= 1 && item.kind === 'isolate' ? 'approved' : item.status }
              : item),
          timeline: [timelineEntry(roleActors[state.role], `审批处置动作：${action.title}`), ...state.incident.timeline]
        }
      });
      return ok('已记录审批');
    },

    executeAction: (id) => {
      const state = get();
      const action = state.incident.actions.find((item) => item.id === id);
      if (!action) return denied('动作不存在');
      if (state.demoMode) return denied('只读演示模式已开启');
      if (state.role === 'viewer') return denied('访客无权执行');
      if (action.kind === 'isolate' && action.approvals.length < 2) return denied('隔离动作需两名不同角色确认');
      set({
        incident: {
          ...state.incident,
          actions: state.incident.actions.map((item) => (item.id === id ? { ...item, status: 'executed' } : item)),
          timeline: [timelineEntry(roleActors[state.role], `执行处置动作：${action.title}`, action.sensitive), ...state.incident.timeline]
        }
      });
      return ok('动作已执行');
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

    tick: () => set((state) => ({
      incident: {
        ...state.incident,
        timeline: [timelineEntry('监测代理', `实时检查：${state.incident.affected.length} 项资产状态已更新`), ...state.incident.timeline].slice(0, 40)
      }
    })),

    // —— 主事件变化 → 触发修订流程 ——

    /** 新证据：写入时间线，并使旧批准失效、通报退回待审 */
    addEvidence: (payload) => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      if (state.role === 'viewer') return denied('访客无权补充证据');
      if (!payload.text.trim()) return denied('证据内容不能为空');
      const incident = applyRevision(
        state, '新证据出现', roleActors[state.role], payload.sensitive,
        `新证据：${payload.text.trim()}`
      );
      set({ incident });
      return ok(`新证据已入时间线，通报修订至 v${incident.bulletin.version}，原批准失效`);
    },

    /** 影响范围变化：新增受影响资产 → 旧批准失效、通报退回待审 */
    addAffectedAsset: (asset) => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      if (state.role === 'viewer') return denied('访客无权变更影响范围');
      const value = asset.trim();
      if (!value) return denied('资产标识不能为空');
      if (state.incident.affected.includes(value)) return denied('该资产已在影响范围内');
      const incident = applyRevision(
        state, '影响范围扩大', roleActors[state.role], true,
        `影响范围更新：新增受影响资产 ${value}`
      );
      set({ incident: { ...incident, affected: [...incident.affected, value] } });
      return ok(`已新增受影响资产 ${value}，通报修订至 v${incident.bulletin.version}，原批准失效`);
    },

    /** 处置状态变化 → 旧批准失效、通报退回待审 */
    updateIncidentStatus: (status) => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      if (state.role !== 'responder') return denied('仅响应负责人可变更处置状态');
      if (state.incident.status === status) return denied('处置状态未发生变化');
      const statusNames: Record<Incident['status'], string> = { investigating: '调查中', contained: '已遏制', recovered: '已恢复' };
      const incident = applyRevision(
        state, '处置状态变化', roleActors[state.role], false,
        `处置阶段变更：${statusNames[state.incident.status]} → ${statusNames[status]}`
      );
      set({ incident: { ...incident, status } });
      return ok(`处置状态更新为「${statusNames[status]}」，通报修订至 v${incident.bulletin.version}，原批准失效`);
    },

    // —— 法务/公关各自维护对外口径：保存即产生新版本，旧批准失效 ——

    editBulletinTitle: (title) => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      if (!canEditBulletin(state.role)) return denied('仅法务或公关可修改对外口径');
      const value = title.trim();
      if (!value) return denied('通报标题不能为空');
      if (value === state.incident.bulletin.title) return denied('标题无变化');
      const b0 = state.incident.bulletin;
      const bulletin = reviseBulletin(b0, '对外口径（标题）修订', roleActors[state.role]);
      bulletin.title = value;
      set({
        incident: {
          ...state.incident,
          bulletin,
          timeline: [timelineEntry(roleActors[state.role], `对外通报标题修订，版本 v${b0.version} → v${bulletin.version}，原批准失效`), ...state.incident.timeline]
        }
      });
      return ok(`已保存为 v${bulletin.version}，需重新会签`);
    },

    editBulletinParagraph: (id, body) => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      if (!canEditBulletin(state.role)) return denied('仅法务或公关可修改对外口径');
      const b0 = state.incident.bulletin;
      const paragraph = b0.paragraphs.find((p) => p.id === id);
      if (!paragraph) return denied('段落不存在');
      const value = body.trim();
      if (!value) return denied('段落内容不能为空');
      if (value === paragraph.body) return denied('内容无变化');
      const bulletin = reviseBulletin(b0, `对外口径（${paragraph.title}）修订`, roleActors[state.role]);
      bulletin.paragraphs = bulletin.paragraphs.map((p) => (p.id === id ? { ...p, body: value } : p));
      set({
        incident: {
          ...state.incident,
          bulletin,
          timeline: [timelineEntry(roleActors[state.role], `对外通报段落「${paragraph.title}」修订，版本 v${b0.version} → v${bulletin.version}，原批准失效`), ...state.incident.timeline]
        }
      });
      return ok(`已保存为 v${bulletin.version}，需重新会签`);
    },

    /**
     * 会签：响应负责人 + 法务，按角色去重（同角色重复确认只算一次）。
     * 乐观锁：携带所看版本 baseVersion；两个角色同时提交时，后到一方若版本已变会被拒绝并看到新版本。
     */
    signBulletin: (baseVersion) => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      const role = state.role;
      if (!COSIGN_ROLES.includes(role)) return denied(role === 'viewer' ? '访客无会签权' : '该角色不属于会签人（需响应负责人与法务）');
      const b0 = state.incident.bulletin;
      if (b0.status === 'published') return denied('通报已发布，修订请先编辑新版本');
      if (b0.version !== baseVersion) {
        return denied(`版本已变化：你看到的是 v${baseVersion}，当前为 v${b0.version}（${b0.updatedBy} 刚更新），请查看最新版本后再会签`);
      }
      const existing = activeApprovals(b0).find((a) => a.role === role);
      if (existing) return denied(`同一角色（${roleActors[role]}）重复确认只算一次，当前 v${baseVersion} 已记录你的会签`);

      const record: ApprovalRecord = {
        id: uid('ap'), at: nowIso(), role, actor: roleActors[role],
        version: b0.version, baseVersion, status: 'active'
      };
      const approvals = [record, ...b0.approvals];
      const withSign = { ...b0, approvals };
      const ready = cosignReady(withSign);
      const bulletin: Bulletin = {
        ...withSign,
        // 任一会签提交即进入待审；双角色齐了转为已批准待发布
        status: ready ? 'approved' : 'pending'
      };
      set({
        incident: {
          ...state.incident,
          bulletin,
          timeline: [
            timelineEntry(roleActors[role], ready
              ? `会签完成（响应负责人 + 法务），对外通报 v${b0.version} 已批准，可发布`
              : `${roleActors[role]} 会签确认 v${b0.version}，等待另一会签角色`),
            ...state.incident.timeline
          ]
        }
      });
      return ok(ready ? '双角色会签完成，通报已批准' : '会签已记录，等待另一角色确认');
    },

    /** 发布：锁定待重试内容与审批现场快照；失败保留现场，状态转 failed */
    publishBulletin: () => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      if (!['responder', 'legal', 'pr'].includes(state.role)) return denied('当前角色无权发布');
      const b0 = state.incident.bulletin;
      if (b0.status !== 'approved') return denied('通报未完成双角色会签，不能发布');

      const ticket = b0.publishResult?.ticket ?? `REL-${state.incident.id}-v${b0.version}`;
      const snapshot: PublishResult = {
        ticket,
        attempts: 1,
        status: 'failure',
        channel: '官网公告 + 客户邮件',
        lastError: '对端网关 503，通道暂不可用（模拟发布失败）',
        approvalSnapshot: activeApprovals(b0),
        snapshotVersion: b0.version,
        snapshotTitle: b0.title,
        snapshotParagraphs: b0.paragraphs.map((p) => ({ ...p }))
      };
      const bulletin: Bulletin = { ...b0, status: 'failed', publishResult: snapshot };
      set({
        incident: {
          ...state.incident,
          bulletin,
          timeline: [
            timelineEntry(roleActors[state.role], `对外通报 v${b0.version} 发布失败：${snapshot.lastError}；已保留待重试内容与审批现场`),
            ...state.incident.timeline
          ]
        }
      });
      return ok('发布失败：已保留待重试内容和审批现场，可重试发布');
    },

    /** 重试：沿用同一发布单，attempts +1，只更新这一条发布结果（幂等，不产生新单号） */
    retryPublish: () => {
      const state = get();
      if (state.demoMode) return denied('只读演示模式已开启');
      if (!['responder', 'legal', 'pr'].includes(state.role)) return denied('当前角色无权发布');
      const b0 = state.incident.bulletin;
      const r = b0.publishResult;
      if (b0.status !== 'failed' || !r) return denied('当前没有失败待重试的发布');

      // 模拟：第一次重试成功（现场内容直接发布；即使通报已被修订也按快照发布）
      const updated: PublishResult = {
        ...r,
        attempts: r.attempts + 1,
        status: 'success',
        publishedAt: nowIso(),
        lastError: undefined
      };
      const bulletin: Bulletin = { ...b0, status: 'published', publishResult: updated };
      set({
        incident: {
          ...state.incident,
          bulletin,
          timeline: [
            timelineEntry(roleActors[state.role], `重试发布成功：发布单 ${updated.ticket}（第 ${updated.attempts} 次尝试），按 v${r.snapshotVersion} 会签内容发布，仅生成一条发布结果`),
            ...state.incident.timeline
          ]
        }
      });
      return ok(`重试成功：${updated.ticket}，共 ${updated.attempts} 次尝试，仍为同一条发布结果`);
    },

    resetDemo: () => set({ incident: structuredClone(initial) })
  };
}, {
  name: 'yf56-incident-store-v2',
  version: 2
}));
