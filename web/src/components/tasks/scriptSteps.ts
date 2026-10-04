/**
 * 把案例的測試腳本(task 原文,可能是 Markdown / 編號清單 / 擠在同一行的「1. … 2. …」)
 * 轉成乾淨的條列步驟,讓任務詳情頁以清單呈現,而不是一大段原文。
 */
export interface ScriptStep {
  text: string;
  /** 縮排的子項目(例:「- 帳號:xxx」)。 */
  sub: string[];
}
export interface ParsedScript {
  /** 清單之前的說明文字(通常是測試目標)。 */
  intro: string[];
  steps: ScriptStep[];
}

const NUM_RE = /^\s*(?:步驟\s*)?(\d{1,2})\s*[.、)）:：]\s*/;
const BULLET_RE = /^(\s*)[-*•・]\s+/;

/** 去掉 Markdown 記號(標題 #、粗體/斜體、行內程式碼、連結語法)。 */
function stripMd(s: string): string {
  return s
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 單行內的「1. xx 2. yy 3. zz」切成多步(數字需遞增,避免把「第 10 轉」誤切)。 */
function splitInlineNumbered(line: string): string[] | null {
  const re = /(?:^|\s)(\d{1,2})\s*[.、)）]\s*/g;
  const marks: Array<{ n: number; at: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const n = Number(m[1]);
    const expected = marks.length === 0 ? n : marks[marks.length - 1]!.n + 1;
    if (n === expected) marks.push({ n, at: m.index, end: m.index + m[0].length });
  }
  if (marks.length < 2) return null;
  const parts: string[] = [];
  const head = line.slice(0, marks[0]!.at).trim();
  if (head) parts.push(`\u0000${head}`); // 標記為 intro
  marks.forEach((mk, i) => {
    const seg = line.slice(mk.end, i + 1 < marks.length ? marks[i + 1]!.at : undefined).trim();
    if (seg) parts.push(seg);
  });
  return parts;
}

export function parseScript(raw: string | undefined | null): ParsedScript {
  const out: ParsedScript = { intro: [], steps: [] };
  if (!raw || !raw.trim()) return out;
  const lines = raw
    .replace(/```[\s\S]*?```/g, (blk) => blk.replace(/```\w*/g, ''))
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*(---+|\*\*\*+)\s*$/.test(l));

  let sawList = false;
  for (const line of lines) {
    const bullet = BULLET_RE.exec(line);
    const num = NUM_RE.exec(line);
    if (num) {
      sawList = true;
      const inline = splitInlineNumbered(line);
      if (inline) {
        for (const p of inline) {
          if (p.startsWith('\u0000')) out.intro.push(stripMd(p.slice(1)));
          else out.steps.push({ text: stripMd(p), sub: [] });
        }
      } else {
        out.steps.push({ text: stripMd(line.slice(num[0].length)), sub: [] });
      }
      continue;
    }
    if (bullet) {
      sawList = true;
      const indented = bullet[1]!.length >= 2;
      const text = stripMd(line.slice(bullet[0].length));
      const last = out.steps[out.steps.length - 1];
      if (indented && last) last.sub.push(text);
      else out.steps.push({ text, sub: [] });
      continue;
    }
    // 非清單行:在清單開始前 → 說明;清單中途且縮排 → 併入上一步子項目;否則可能是擠在一行的編號清單。
    const inline = splitInlineNumbered(line);
    if (inline) {
      sawList = true;
      for (const p of inline) {
        if (p.startsWith('\u0000')) out.intro.push(stripMd(p.slice(1)));
        else out.steps.push({ text: stripMd(p), sub: [] });
      }
      continue;
    }
    const text = stripMd(line);
    const last = out.steps[out.steps.length - 1];
    if (sawList && last && /^\s{2,}/.test(line)) last.sub.push(text);
    else if (!sawList) out.intro.push(text);
    else out.steps.push({ text, sub: [] });
  }

  // 完全沒有清單記號的長段落:依句號/分號切成步驟,避免一大段字。
  if (out.steps.length === 0 && out.intro.length > 0) {
    const all = out.intro.join(' ');
    const sentences = all.split(/(?<=[。;；!！])\s*|\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length > 1) {
      out.intro = [];
      out.steps = sentences.map((s) => ({ text: s.replace(/[。;；]$/, ''), sub: [] }));
    }
  }
  out.steps = out.steps.filter((s) => s.text);
  return out;
}
