import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const lt = await import('../../agent/localeText.mjs');
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const ev = await import('../../agent/evidenceProtocol.mjs');
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const at = await import('../../agent/agentTeam.mjs');
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const emu = await import('../lambda/engine/emulatorRunner.mjs');

const LOCS = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'];
const NAMES: Record<string, string> = { en: 'English', 'zh-Hans': '简体中文', ja: '日本語', ko: '한국어' };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('languageDirective', () => {
  test('zh-Hant / 未設 / 未知 = 空字串', () => {
    for (const l of ['zh-Hant', undefined, '', 'xx', 'zh']) expect(lt.languageDirective(l)).toBe('');
  });
  test.each(['en', 'zh-Hans', 'ja', 'ko'])('%s 含語言名稱', (l) => {
    expect(lt.languageDirective(l)).toContain(NAMES[l]!);
  });
});

describe('emulatorRunner buildSystemPrompt', () => {
  const ss = { w: 1080, h: 1920 };
  // 改版前輸出的 SHA-256(zh-Hant / 未設語系必須逐位元相同)。
  const BEFORE_NO_KB = '95e7a4cd0112ca6b9a06b73cc313316b50ec7e310272c389d316f95ed7a71f92';
  const BEFORE_KB = '584e7e9c44400d868dc7ee3935c9dbff72437a02867c3ce87c65e10ab709de69';
  test('zh-Hant 與未設語系與舊版逐位元相同', () => {
    for (const l of [undefined, '', 'zh-Hant']) {
      expect(sha(emu.buildSystemPrompt(ss, '', l))).toBe(BEFORE_NO_KB);
      expect(sha(emu.buildSystemPrompt(ss, 'KB text', l))).toBe(BEFORE_KB);
    }
    expect(sha(emu.buildSystemPrompt(ss, ''))).toBe(BEFORE_NO_KB);
  });
  test.each(['en', 'zh-Hans', 'ja', 'ko'])('%s 含語言名稱', (l) => {
    expect(emu.buildSystemPrompt(ss, 'KB text', l)).toContain(NAMES[l]!);
  });
});

describe('agentTeam prompts', () => {
  class FakeConverse { constructor(public input: { system: Array<{ text: string }> }) {} }
  async function systems(locale?: string) {
    const seen: string[] = [];
    const bedrock = {
      send: async (cmd: FakeConverse) => {
        seen.push(cmd.input.system[0]!.text);
        return { output: { message: { content: [{ text: '{"effect":"ok","ok":true,"action":"wait","element":null,"summary":"s"}' }] } }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const team = at.createAgentTeam({
      bedrock, ConverseCommand: FakeConverse, agentModel: 'm1', subagentModel: 'm2', task: '1. a\n2. b',
      put: async () => {}, prefix: 'p', timeoutMs: 1000, ...(locale !== undefined ? { locale } : {}),
    });
    const obs = { screen: 's', thinking: 't' };
    await team.decideAction({ index: 1, observation: obs, elements: [], suggestion: null, screenChanged: true, allowedActions: ['tap'], dims: { cw: 10, ch: 10 } });
    await team.review({ index: 1, prevAction: 'tap', prevPlan: null, observation: obs, screenChanged: true });
    await team.verifyDone({ index: 1, observation: obs });
    for (let i = 1; i <= 8; i++) team.record({ index: i, screen: 's', action: 'tap', effect: 'ok' });
    await team.maybeSummarize(8);
    return seen;
  }
  test('zh-Hant 與未設語系的 system prompt 相同,且沒有語言指示', async () => {
    const a = await systems();
    const b = await systems('zh-Hant');
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(b).toEqual(a);
    for (const s of a) expect(s).not.toContain('[Output language]');
  });
  test.each(['en', 'zh-Hans', 'ja', 'ko'])('%s 的決策/審核/完成/摘要 prompt 含語言名稱', async (l) => {
    const seen = await systems(l);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const s of seen) expect(s).toContain(NAMES[l]!);
  });
});

describe('evidence protocol', () => {
  const evidence = { modules: [], mechanics: [], observe: [] };
  test('zh-Hant / 未設語系的證據 prompt 與舊版相同(沒有 phase)', () => {
    const none = ev.evidencePromptSection(evidence);
    expect(ev.evidencePromptSection(evidence, { locale: 'zh-Hant' })).toBe(none);
    expect(none).not.toContain('"phase"');
  });
  test.each(['en', 'zh-Hans', 'ja', 'ko'])('%s 的證據 prompt 要求 phase', (l) => {
    const p = ev.evidencePromptSection(evidence, { locale: l });
    expect(p).toContain('"phase"');
    for (const id of ev.PHASE_IDS) expect(p).toContain(id);
  });
  test('evidenceFields 只收合法的 phase', () => {
    expect(ev.evidenceFields({ phase: 'Gameplay' }, 'tap').phase).toBe('gameplay');
    expect(ev.evidenceFields({ phase: 'ゲーム' }, 'tap').phase).toBeUndefined();
    expect(ev.evidenceFields({}, 'tap').phase).toBeUndefined();
  });
});

describe('runnerText', () => {
  const params = { message: 'm', kind: 'tap', name: 'N', n: 3, round: 2, of: 5, target: 'T', action: 'tap', to: 'X', how: 'h', trust: 'tr', from: 'up', dir: 'left', pct: 60, keys: 'a', };
  // zh-Hant 必須與舊 runner 的字串逐字相同。
  const OLD: Record<string, string> = {
    parseFail: '無法解析回應,等待後重試',
    parseFailJson: '無法解析回應 JSON,等待後重試',
    modelFail: '模型呼叫失敗:m',
    takeover: '測試人員接管:tap',
    memWait: '[記憶腳本] 等「N」載入(3/6)。',
    memStill: '[記憶腳本] 畫面還沒反應,再等一下。',
    spinLoop: '[SPIN 迴圈] 第 2/5 局:照記憶點「T」。',
    spinLoopNav: '[SPIN 迴圈] 第 2/5 局:照記憶點「T」(導航腳本挑到的同一顆 SPIN)。',
    memNav: '[記憶腳本] 認出「N」→ tap「T」前往「X」(h;tr)。',
    battleMove: '[戰鬥強制走位] 偵測到戰鬥畫面,角色必須持續移動躲怪。原動作(tap)改為 move dir=left 走位。',
    blockedMove: '[走位被擋改向] 上一步往 up 背景沒有移動(被障礙物擋住),改往 left。',
    factsChanged: '數值有變化(a)',
    stuckBand: '連續 3 步畫面沒變,掃描中下段主按鈕帶 y=60% 脫困',
    stuckBack: '連續 3 步畫面沒變,用 back 脫困',
    stuckCorner: '連續 3 步畫面沒變,點右上角(關閉鈕常在此)脫困',
  };
  test('每個 key 都有五種語系', () => {
    expect(Object.keys(lt.RUNNER_TEXT).sort()).toEqual(Object.keys(OLD).sort());
    for (const key of Object.keys(lt.RUNNER_TEXT)) {
      for (const l of LOCS) expect(typeof lt.RUNNER_TEXT[key][l]).toBe('function');
    }
  });
  test('zh-Hant 與未設語系 = 舊字串', () => {
    for (const [key, old] of Object.entries(OLD)) {
      expect(lt.runnerText('zh-Hant', key, { ...params, from: 'up', to: key === 'blockedMove' ? 'left' : 'X' })).toBe(old);
      expect(lt.runnerText(undefined, key, { ...params, to: key === 'blockedMove' ? 'left' : 'X' })).toBe(old);
    }
  });
  test('機器前綴在所有語系都留在最前面', () => {
    const prefixes: Record<string, string> = {
      parseFail: '無法解析回應', parseFailJson: '無法解析回應', modelFail: '模型呼叫失敗',
      memWait: '[記憶腳本]', memStill: '[記憶腳本]', memNav: '[記憶腳本]',
      spinLoop: '[SPIN 迴圈]', spinLoopNav: '[SPIN 迴圈]', battleMove: '[戰鬥強制走位]', blockedMove: '[走位被擋改向]',
    };
    for (const [key, p] of Object.entries(prefixes)) {
      for (const l of LOCS) expect(lt.runnerText(l, key, params).startsWith(p)).toBe(true);
    }
  });
  test('非 zh-Hant 語系的句子與 zh-Hant 不同', () => {
    for (const key of Object.keys(OLD)) {
      for (const l of ['en', 'zh-Hans', 'ja', 'ko']) expect(lt.runnerText(l, key, params)).not.toBe(lt.runnerText('zh-Hant', key, params));
    }
  });
});

describe('runner wiring', () => {
  const AGENT = join(__dirname, '..', '..', 'agent');
  const src = (f: string) => readFileSync(join(AGENT, f), 'utf8');
  test.each(['explorationRunner.mjs', 'webExplorationRunner.mjs'])('%s 讀 ctx.locale 並在 prompt 尾端附上語言指示', (f) => {
    const s = src(f);
    expect(s).toContain('ctx.locale');
    expect(s).toContain('languageDirective(LOCALE)');
    expect(s).toContain('locale: LOCALE');
  });
  test('emulatorRunner 讀 ctx.locale', () => {
    expect(readFileSync(join(__dirname, '..', 'lambda', 'engine', 'emulatorRunner.mjs'), 'utf8')).toContain('ctx.locale');
  });
});
