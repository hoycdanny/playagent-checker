/**
 * 缺陷的人工覆寫 —— 把測試人員的判斷套到機器判定上。
 *
 * 為什麼是純函式、而且刻意放在 findings 組好之後立刻套用:
 *   findings 會餵給驗收條件(AC-G02 當機、AC-G03 嚴重缺陷)、品質儀表板、
 *   模組統計、指標與放行規則。在這個單一位置套用覆寫,整條判定鏈就自然重算,
 *   不必在六個地方各自處理覆寫 —— 分散處理遲早會有一處漏掉,而漏掉的症狀是
 *   「報告某幾個數字算進覆寫、某幾個沒算」,比完全不支援覆寫更難查。
 *
 * 三條不可退讓的規則(見 types.ts 的 FindingOverride):
 *   1. 原判定永久保留在 override.original。
 *   2. 沒有理由的覆寫一律忽略 —— 報告必須能交代數字為什麼變了。
 *   3. 標為誤判的缺陷降級為 NEEDS_TRIAGE 而不是從清單刪除。
 *      刪除會讓報告看起來從來沒發現過這件事,那是偽造證據;
 *      降級則保留「AI 曾經報過、被人工駁回」這個事實。
 */
import type { AppliedOverride, FailureClass, Finding, FindingOverride, Severity } from './types.js';

const CLASSES: ReadonlySet<string> = new Set<FailureClass>([
  'GAME_FAILURE', 'AI_TEST_FAILURE', 'ENVIRONMENT', 'NEEDS_TRIAGE',
]);
const SEVERITIES: ReadonlySet<string> = new Set<Severity>(['critical', 'high', 'medium', 'low']);

/** 覆寫是否可用:必須指向某一筆缺陷、有非空理由、有覆寫者,且至少改了一件事。 */
export function isUsableOverride(o: unknown): o is FindingOverride {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  if (typeof r['findingId'] !== 'string' || !r['findingId'].trim()) return false;
  if (typeof r['reason'] !== 'string' || !r['reason'].trim()) return false;
  if (typeof r['by'] !== 'string' || !r['by'].trim()) return false;
  const changes =
    r['dismissed'] === true ||
    (typeof r['classification'] === 'string' && CLASSES.has(r['classification'])) ||
    (typeof r['severity'] === 'string' && SEVERITIES.has(r['severity']));
  return changes;
}

/**
 * 把覆寫套到缺陷清單上。
 *
 * @param findings 機器判定的缺陷(原始順序保留)
 * @param overrides 覆寫紀錄;同一筆缺陷有多筆時以**最後寫入的**為準(at 最大)
 */
export function applyFindingOverrides(
  findings: Finding[],
  overrides: readonly FindingOverride[] | undefined,
): Finding[] {
  if (!overrides?.length) return findings;

  // 同一筆缺陷可能被改過多次(例如先標誤判、再改回確認)。以時間最晚的為準,
  // 而不是以陣列順序 —— 儲存層的順序不保證等於時間順序。
  const latest = new Map<string, FindingOverride>();
  for (const o of overrides) {
    if (!isUsableOverride(o)) continue;
    const prev = latest.get(o.findingId);
    if (!prev || String(o.at ?? '') >= String(prev.at ?? '')) latest.set(o.findingId, o);
  }
  if (latest.size === 0) return findings;

  return findings.map((f) => {
    const o = latest.get(f.id);
    if (!o) return f;

    const applied: AppliedOverride = {
      // 原判定永久保留:報告要能並列「原判定 / 人工覆寫」
      original: { classification: f.classification, severity: f.severity },
      dismissed: o.dismissed === true,
      reason: o.reason.trim(),
      by: o.by,
      at: o.at,
    };

    // 標為誤判 → 降級為待判讀,不從清單移除。
    // 移除會讓報告看起來從來沒發現過這件事;降級保留「AI 報過、被人工駁回」的事實,
    // 同時讓它不再計入已確認缺陷(所以不會繼續擋放行)。
    if (applied.dismissed) {
      return { ...f, classification: 'NEEDS_TRIAGE' as FailureClass, override: applied };
    }

    return {
      ...f,
      ...(o.classification ? { classification: o.classification } : {}),
      ...(o.severity ? { severity: o.severity } : {}),
      override: applied,
    };
  });
}

/** 這份報告是否含人工覆寫(放行結論那一行要據此標明)。 */
export function hasOverrides(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.override !== undefined);
}

/** 覆寫的件數摘要,供報告說明使用。 */
export function overrideSummary(findings: readonly Finding[]): {
  total: number;
  dismissed: number;
  reclassified: number;
} {
  const over = findings.filter((f) => f.override);
  return {
    total: over.length,
    dismissed: over.filter((f) => f.override!.dismissed).length,
    reclassified: over.filter((f) => !f.override!.dismissed).length,
  };
}
