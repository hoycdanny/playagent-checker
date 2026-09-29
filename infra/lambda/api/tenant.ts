/**
 * 租戶身分:只從 Cognito JWT 的 claims 推導,絕不信任請求主體自述的 tenantId
 * (Req 1.3);身分推不出即視為未授權(Req 1.4)。
 */
export interface TenantContext {
  tenantId: string;
  sub: string;
  email: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 由 authorizer 驗證過的 JWT claims 取出租戶身分。
 * tenantId 存於自訂屬性 `custom:tenantId`。
 */
export function tenantFromClaims(claims: unknown): TenantContext {
  if (!isRecord(claims)) {
    throw new UnauthorizedError('缺少身分 claims');
  }
  const tenantId = claims['custom:tenantId'];
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new UnauthorizedError('身分中缺少 custom:tenantId');
  }
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthorizedError('身分中缺少 sub');
  }
  const email = typeof claims['email'] === 'string' ? claims['email'] : null;
  return { tenantId, sub, email };
}

/** admin 群組名(與 CDK ADMIN_GROUP 一致)。JWT cognito:groups 含此值者為管理員。 */
export const ADMIN_GROUP = 'admins';

/**
 * 從 JWT claims 解析所屬群組。Cognito 的 cognito:groups 在 ID/Access token 可能是
 * 陣列(JSON authorizer)或以逗號/空白分隔的字串(部分整合),兩者都處理。
 */
export function groupsFromClaims(claims: unknown): string[] {
  if (!isRecord(claims)) return [];
  const g = claims['cognito:groups'];
  if (Array.isArray(g)) return g.filter((x): x is string => typeof x === 'string');
  if (typeof g === 'string') {
    // 可能形如 "[admins]" 或 "admins,other" 或 "admins other"
    return g.replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean);
  }
  return [];
}

/** 是否為管理員(cognito:groups 含 admins)。 */
export function isAdmin(claims: unknown): boolean {
  return groupsFromClaims(claims).includes(ADMIN_GROUP);
}

/** 未授權錯誤 —— 由 API 核心映射為 401。 */
export class UnauthorizedError extends Error {}

/** 權限不足 —— 由 API 核心映射為 403(已登入但非 admin)。 */
export class ForbiddenError extends Error {}
