/**
 * 「以測項為主」(scripted)的判定與知識庫收斂。
 *
 * 2026-10-15(job-mv95w48j-37kbi3):案例是 `task:` 的 4 個編號步驟 + `assertions:`,但只有 `items:`
 * 才算測項 → 走探索模式;AI 第 2 分鐘就進了遊戲,卻照拉霸知識庫的「測試重點」(派彩、免費遊戲…)
 * 與遊戲新手任務又玩了 2 小時。改成:有編號步驟或驗收條件就以測項為主,且知識庫只留「看懂畫面」的部分。
 */

/** 與 runner 的 scriptSteps(agent/agentTeam.mjs)同一個規則:編號或條列開頭。 */
const STEP_LINE_RE = /^(?:\d+\s*[.、)\]]|[-•*])\s*\S/;

/** task 文字是否為分步驟的測試腳本(≥ 2 個編號 / 條列步驟)。 */
export function taskHasSteps(task: string | undefined): boolean {
  if (!task) return false;
  return task.split(/\r?\n/).filter((l) => STEP_LINE_RE.test(l.trim())).length >= 2;
}

/** YAML 頂層 `assertions:` 是否至少有一條(區塊清單或行內 [a, b])。 */
export function caseHasAssertions(yaml: string): boolean {
  const lines = yaml.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^assertions:/.test(l));
  if (idx < 0) return false;
  const inline = lines[idx]!.replace(/^assertions:/, '').replace(/\s#.*$/, '').trim();
  if (inline) return inline !== '[]' && inline !== '~' && inline !== 'null';
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s+-\s*\S/.test(l)) return true;
    if (l.trim() !== '' && !/^\s/.test(l)) break;
  }
  return false;
}

/**
 * 案例是否「以測項為主」:結構化測項(items:)、分步驟的 task、或有驗收條件(assertions:)。
 * 是的話 runner 逐項判定、全部達成就結束,知識庫只用來看懂畫面。
 */
export function isScriptedCase(yaml: string, task: string | undefined): boolean {
  return /^items:\s*$/m.test(yaml) || taskHasSteps(task) || caseHasAssertions(yaml);
}

/** 知識庫裡「要 AI 去測什麼」的段落標題(測項為主時移除,只保留畫面 / 操作 / 術語等看懂畫面用的內容)。 */
const FOCUS_HEADING_RE = /^#{1,6}\s*(?:測試重點|测试重点|測試要點|测试要点|測試項目建議|測試建議|测试建议|test(?:ing)?\s+focus|what\s+to\s+test)/i;

/** 移除知識庫 Markdown 的「測試重點」段落(到下一個任意層級標題為止)。 */
export function stripTestFocus(markdown: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) skipping = FOCUS_HEADING_RE.test(line);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
