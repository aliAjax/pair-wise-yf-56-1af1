export type Role = 'analyst' | 'responder' | 'legal' | 'pr' | 'viewer';

export const roleLabels: Record<Role, string> = {
  analyst: '分析员',
  responder: '响应负责人',
  legal: '法务',
  pr: '公关',
  viewer: '访客'
};

/** 处置动作 / 时间线等既有敏感内容的可见角色 */
export const internalRoles: Role[] = ['responder', 'legal', 'pr'];
