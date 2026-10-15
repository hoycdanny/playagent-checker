/**
 * 案例 YAML 的頂層 `keys:`(按鍵對應)讀寫(與後端 controlSchemes.parseCaseKeys 對齊)。
 * 格式(獨立的頂層區塊,不放進 controls: 以免破壞 controls 的單行寫法):
 *   keys:
 *     - up: 移動(上)
 *     - z: 確認 / 推進對話
 *     - mouse_right: 取消
 */

export interface CaseKey {
  /** 標準按鍵名(up / enter / z / mouse_right …)。 */
  key: string;
  /** 使用者寫的用途。 */
  purpose: string;
}

const HEAD_RE = /^keys:/;

/** 找出 keys: 區塊的範圍 [start, end);沒有回 null。 */
function blockRange(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => HEAD_RE.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]!) || (lines[end]!.trim() === '' && /^\s+\S/.test(lines[end + 1] ?? '')))) end++;
  return [start, end];
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');

/** 讀 keys:;沒寫 → undefined。 */
export function readKeys(yaml: string): CaseKey[] | undefined {
  const lines = yaml.split(/\r?\n/);
  const range = blockRange(lines);
  if (!range) return undefined;
  const out: CaseKey[] = [];
  for (let i = range[0] + 1; i < range[1]; i++) {
    const m = /^\s+-\s*(.+?)\s*[:：]\s*(.*)$/.exec(lines[i]!);
    if (m) out.push({ key: unquote(m[1]!).toLowerCase(), purpose: unquote(m[2]!) });
  }
  return out;
}

/** 一行用途:去換行、壓空白(YAML 是逐行解析,換行會截斷)。 */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 以 keys 改寫 keys: 區塊;空清單 = 移除區塊。yaml 為空時不動(等草擬/手寫後再套)。 */
export function writeKeys(yaml: string, keys: CaseKey[]): string {
  if (!yaml.trim()) return yaml;
  const lines = yaml.split(/\r?\n/);
  const range = blockRange(lines);
  const rows = keys.filter((k) => k.key.trim());
  const block = rows.length ? ['keys:', ...rows.map((k) => `  - ${k.key.trim()}: ${oneLine(k.purpose)}`.trimEnd())] : [];
  if (range) {
    lines.splice(range[0], range[1] - range[0], ...block);
    return lines.join('\n');
  }
  if (!block.length) return yaml;
  // 放在 controls: 之後(沒有就放 name: 之後,再沒有放最前面)。
  const ctl = lines.findIndex((l) => /^controls:/.test(l));
  let at: number;
  if (ctl >= 0) {
    at = ctl + 1;
    if (!lines[ctl]!.replace(/^controls:/, '').replace(/#.*$/, '').trim()) {
      while (at < lines.length && /^\s+-\s*/.test(lines[at]!)) at++;
    }
  } else {
    const nameIdx = lines.findIndex((l) => /^name:/.test(l));
    at = nameIdx >= 0 ? nameIdx + 1 : 0;
  }
  lines.splice(at, 0, ...block);
  return lines.join('\n');
}

/** keys undefined / 空 → 移除區塊;否則寫入。 */
export function applyKeys(yaml: string, keys: CaseKey[] | undefined): string {
  return writeKeys(yaml, keys ?? []);
}
