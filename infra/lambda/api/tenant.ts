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

/** 未授權錯誤 —— 由 API 核心映射為 401。 */
export class UnauthorizedError extends Error {}
