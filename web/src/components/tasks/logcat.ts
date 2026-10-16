/** 裝置 logcat(-v epoch)解析(日誌檢視與任務時間軸共用)。 */

export interface LogLine { t: number; pid: number; tid: number; level: string; tag: string; msg: string; raw: string }

const LINE_RE = /^\s*(\d{9,}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/;

/** logcat(-v epoch)文字 → 行(t = 裝置時鐘 epoch ms);回傳行與片段標頭裡的被測 App pid。 */
export function parseLogcat(text: string): { lines: LogLine[]; pid?: number } {
  const lines: LogLine[] = [];
  let pid: number | undefined;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('#')) {
      const m = /pid=(\d+)/.exec(raw);
      if (m) pid = Number(m[1]);
      continue;
    }
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    lines.push({ t: Math.round(Number(m[1]) * 1000), pid: Number(m[2]), tid: Number(m[3]), level: m[4]!, tag: m[5]!, msg: m[6]!, raw });
  }
  return { lines, ...(pid ? { pid } : {}) };
}

/**
 * 片段標頭 `# step= at= pid= dev=<裝置秒> sent=<runner ms>` → 裝置時鐘換成 runner 時鐘要加的 ms。
 * runner 時鐘 = 步驟、錄影、AI 呼叫用的時鐘;沒有標頭回 0。
 */
export function clockOffset(text: string): number {
  const head = text.split('\n', 1)[0] ?? '';
  const dev = Number(/dev=(\d{9,}\.\d+)/.exec(head)?.[1]);
  const sent = Number(/sent=(\d+)/.exec(head)?.[1]);
  return Number.isFinite(dev) && Number.isFinite(sent) && dev > 0 && sent > 0 ? sent - Math.round(dev * 1000) : 0;
}

/** logcat 片段 → 已換算成 runner 時鐘的行(依時間排序)。dev = 原本的裝置時間。 */
export function alignLogcat(chunks: Array<{ text?: string }>): Array<LogLine & { dev: number }> {
  const out: Array<LogLine & { dev: number }> = [];
  for (const c of chunks) {
    const text = c.text ?? '';
    const offset = clockOffset(text);
    for (const l of parseLogcat(text).lines) out.push({ ...l, dev: l.t, t: l.t + offset });
  }
  return out.sort((a, b) => a.t - b.t);
}
