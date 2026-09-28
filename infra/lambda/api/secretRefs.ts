/**
 * 被測身分注入的機密引用(Req 14)—— 租戶範圍、Secrets Manager 支撐。
 *
 * 安全不變式:
 * - 租戶範圍(Req 14.3):每個租戶的機密一律落在命名前綴 `playagent/tenant/<tenantId>/` 下。
 *   解析引用時強制驗證目標名稱/ARN 在本租戶前綴內,任何跨租戶引用都拒絕。
 * - 花費前失敗(Req 14.5):引用的機密缺失,在任何執行花費前即失敗,不進裝置階段。
 * - 憑證僅 session 存活期可用(Req 14.2):解析出的值只在單次執行 session 記憶體中傳遞,
 *   不落 S3、不寫報告、不回 API(見 listSecretRefs 只回名稱不回值)。
 * - 不回傳值:API 只能管理「引用清單/名稱」,永不回傳機密明文(Req 14.4)。
 */

/** 租戶機密命名前綴(綁定 tenantId,跨租戶引用無法通過)。 */
export function tenantSecretPrefix(tenantId: string): string {
  return `playagent/tenant/${tenantId}/`;
}

export class SecretRefError extends Error {}

/** 引用形式:`secretRef:<name>` 或完整 Secrets Manager ARN。 */
export interface ParsedSecretRef {
  /** 正規化後的機密名稱(不含 secretRef: 前綴)。 */
  name: string;
  /** 原始引用字串。 */
  raw: string;
}

/**
 * 解析單一機密引用,並強制其落在本租戶前綴內。
 * - `secretRef:<name>`:name 必須以 tenantSecretPrefix(tenantId) 開頭。
 * - ARN:其 secret 名稱段必須以 tenantSecretPrefix(tenantId) 開頭。
 * 任一不符 → SecretRefError(跨租戶引用拒絕)。
 */
export function parseSecretRef(raw: string, tenantId: string): ParsedSecretRef {
  const v = raw.trim().replace(/^["']|["']$/g, '');
  const prefix = tenantSecretPrefix(tenantId);

  if (/^secretRef:/i.test(v)) {
    const name = v.slice(v.indexOf(':') + 1).trim();
    if (!name.startsWith(prefix)) {
      throw new SecretRefError(
        `機密引用不在本租戶範圍內:${name}(必須以 ${prefix} 開頭)`,
      );
    }
    return { name, raw: v };
  }

  if (/^arn:aws:secretsmanager:/i.test(v)) {
    // arn:aws:secretsmanager:<region>:<acct>:secret:<name>-<suffix>
    const marker = ':secret:';
    const idx = v.indexOf(marker);
    if (idx < 0) throw new SecretRefError(`機密 ARN 格式不正確:${v}`);
    let name = v.slice(idx + marker.length);
    // 去掉 Secrets Manager 附加的 6 碼隨機後綴(-abcdef)。
    name = name.replace(/-[A-Za-z0-9]{6}$/, '');
    if (!name.startsWith(prefix)) {
      throw new SecretRefError(
        `機密 ARN 不在本租戶範圍內:${name}(必須以 ${prefix} 開頭)`,
      );
    }
    return { name, raw: v };
  }

  throw new SecretRefError(
    `不是合法機密引用:${v}(需 secretRef:<name> 或 secretsmanager ARN)`,
  );
}

/** 從案例 YAML 掃出所有機密引用並逐一驗證租戶範圍。回傳去重後的引用清單。 */
export function extractSecretRefs(yaml: string, tenantId: string): ParsedSecretRef[] {
  const refs = new Map<string, ParsedSecretRef>();
  // 抓 secretRef:<name> 或 arn:aws:secretsmanager:... 兩種樣態。
  const pattern =
    /(secretRef:[A-Za-z0-9/_.-]+|arn:aws:secretsmanager:[A-Za-z0-9:/_.-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(yaml)) !== null) {
    const parsed = parseSecretRef(m[1]!, tenantId); // 跨租戶會在此拋錯
    refs.set(parsed.name, parsed);
  }
  return [...refs.values()];
}
