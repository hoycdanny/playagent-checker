import { describe, expect, test } from 'vitest';
import { caseHasAssertions, isScriptedCase, stripTestFocus, taskHasSteps } from '../lambda/api/scriptedCase.js';
import { extractCaseTask } from '../lambda/api/core.js';
import { getBuiltinKnowledgeBase } from '../lambda/api/builtinKnowledgeBases.js';
import { createScriptTracker, itemBudgetFor } from '../../agent/scriptTracker.mjs';
// @ts-expect-error 沒有 .d.ts 的 .mjs 模組
const at = await import('../../agent/agentTeam.mjs');

// job-mv95w48j-37kbi3 的案例(原本因為沒有 items: 而走探索模式,跑了 2 小時)。
const CASE = [
  'name: 遊戲大廳啟動與遊戲進入測試',
  'controls: [tap, hold]',
  'app: app-mv7omb5d-4prd3l',
  'task: |',
  '  1. 點擊 PLAY 按鈕進入遊戲',
  '  2. 如果看到每日任務彈窗,點擊 COLLECT 按鈕收集獎勵',
  '  3. 如果出現任何彈出視窗,點擊 X 按鈕關閉',
  '  4. 進入遊戲大廳後,選擇並點擊任意一款遊戲',
  'assertions:',
  '  - 成功進入遊戲大廳',
  '  - 成功點擊並進入任一遊戲',
].join('\n');

describe('isScriptedCase', () => {
  test('numbered task or assertions → scripted (the job-mv95w48j case)', () => {
    expect(isScriptedCase(CASE, extractCaseTask(CASE))).toBe(true);
    expect(taskHasSteps(extractCaseTask(CASE))).toBe(true);
    expect(caseHasAssertions(CASE)).toBe(true);
  });
  test('items: block → scripted', () => {
    expect(isScriptedCase('name: x\ntask: 跑一輪\nitems:\n  - ref: 1\n', '跑一輪')).toBe(true);
  });
  test('assertions only (single-sentence task) → scripted', () => {
    expect(isScriptedCase('task: 進入大廳\nassertions:\n  - 看到大廳', '進入大廳')).toBe(true);
    expect(caseHasAssertions('assertions: [看到大廳]')).toBe(true);
    expect(caseHasAssertions('assertions: []')).toBe(false);
    expect(caseHasAssertions('assertions:\ntask: x')).toBe(false);
  });
  test('free-form exploration goal → not scripted', () => {
    expect(isScriptedCase('task: 自由探索這款遊戲的主要畫面', '自由探索這款遊戲的主要畫面')).toBe(false);
    expect(isScriptedCase('name: x', undefined)).toBe(false);
    expect(taskHasSteps('1. 只有一步')).toBe(false);
  });
});

describe('stripTestFocus', () => {
  test('removes the 測試重點 section from builtin KBs, keeps screens / flows / terms', () => {
    for (const id of ['kb-builtin-slot', 'kb-builtin-casino']) {
      const md = getBuiltinKnowledgeBase(id)!.markdown;
      expect(md).toContain('## 測試重點');
      const out = stripTestFocus(md);
      expect(out).not.toContain('測試重點');
      expect(out).toContain('## 關鍵操作流程');
      expect(out).toMatch(/## 核心畫面/);
    }
  });
  test('stops at the next heading of any level', () => {
    const md = '# A\n## 測試重點\n- 多轉幾局\n- 測免費遊戲\n# B\n內容\n### Testing focus\n- x\n## 術語\n- Wild';
    expect(stripTestFocus(md)).toBe('# A\n# B\n內容\n## 術語\n- Wild');
  });
});

describe('scriptTracker', () => {
  const items = at.scriptSteps(extractCaseTask(CASE)!) as string[];

  test('job-mv95w48j replay: entering a game at step 9 finishes after one confirmation', () => {
    expect(items).toHaveLength(4);
    const t = createScriptTracker({ items });
    // 第 2 步點了 PLAY、第 6 步在大廳、第 9 步進了遊戲(視覺 Agent 回報條件項一併完成)。
    expect(t.observe(1).advanced).toBe(true);
    expect(t.observe(undefined).advanced).toBe(false);
    expect(t.done).toBe(1);
    const claim = t.observe(4, '已進入 Desert Legend 轉軸畫面');
    expect(claim).toMatchObject({ confirm: true, complete: false });
    expect(t.done).toBe(3);
    expect(t.turnNote()).toContain('再確認一次');
    expect(t.observe(4).complete).toBe(true);
    expect(t.done).toBe(4);
  });

  test('progress never goes backwards; a failed confirmation resumes the last item', () => {
    const t = createScriptTracker({ items });
    t.observe(2);
    t.observe(1);
    expect(t.done).toBe(2);
    expect(t.observe(4).confirm).toBe(true);
    const r = t.observe(3);
    expect(r.retracted).toBe(true);
    expect(t.pendingFinal).toBe(false);
    expect(t.current).toBe(4);
    // 沒回報 scriptDone 的確認回合不算確認。
    t.observe(4);
    expect(t.observe(undefined).retracted).toBe(true);
  });

  test('timebox: 20 actions on one item → blocked naming the item; progress resets the budget', () => {
    const t = createScriptTracker({ items, itemBudget: 20 });
    for (let k = 0; k < 15; k++) expect(t.tick()).toBeNull();
    t.observe(1); // 推進 → 重新計算
    for (let k = 0; k < 20; k++) expect(t.tick()).toBeNull();
    const b = t.tick();
    expect(b).toMatchObject({ item: 2, steps: 20, budget: 20 });
    expect(b!.text).toContain('每日任務彈窗');
  });

  test('long / repeated items are not timeboxed; small counts are', () => {
    expect(itemBudgetFor('長按 SPIN 1.5 秒開啟 AutoSpin,跑完 500 局')).toBe(Infinity);
    expect(itemBudgetFor('連續轉動 30 分鐘')).toBe(Infinity);
    expect(itemBudgetFor('轉 100 次並記錄 RTP')).toBe(Infinity);
    expect(itemBudgetFor('點 SPIN 轉 3 次', 20)).toBe(20);
    expect(itemBudgetFor('進入大廳', 20)).toBe(20);
  });

  test('prompt section lists the items and the reporting contract', () => {
    const s = createScriptTracker({ items }).promptSection();
    expect(s).toContain('1. 點擊 PLAY 按鈕進入遊戲');
    expect(s).toContain('"scriptDone"');
    expect(s).toContain('條件沒有出現就算完成');
    expect(s).toContain('不是測試腳本');
    expect(createScriptTracker({ items: [] }).promptSection()).toBe('');
  });
});

describe('agentTeam externalProgress', () => {
  test('decision agent cannot move scriptStep; runner sets it', async () => {
    const bedrock = {
      send: async () => ({ output: { message: { content: [{ text: '{"action":"wait","duration":2,"goal":"等","scriptStep":1}' }] } }, usage: { inputTokens: 1, outputTokens: 1 } }),
    };
    class Cmd { constructor(public input: unknown) {} }
    const team = at.createAgentTeam({
      bedrock, ConverseCommand: Cmd, agentModel: 'm', subagentModel: '', task: CASE.split('task: |\n')[1]!.split('\nassertions')[0]!.replace(/^ {2}/gm, ''),
      put: async () => {}, prefix: 'p', timeoutMs: 1000, scripted: true, externalProgress: true,
    });
    team.setScriptStep(4);
    const r = await team.decideAction({ index: 0, observation: { screen: '轉軸畫面' }, elements: [], suggestion: {}, screenChanged: true, allowedActions: [], dims: { cw: 100, ch: 100 } });
    expect(r).not.toBeNull();
    expect(team.scriptStep).toBe(4);
    expect(r.decision.scriptStep).toBe(4);
  });
});
