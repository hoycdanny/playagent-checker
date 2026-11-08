import { describe, expect, test } from 'vitest';
import { buildStructuredReport } from '../lambda/api/report/engine.js';

/**
 * 報告的主張紀律:一份報告只能主張證據支持的範圍。
 *
 * 三件事要守住:
 *  1. 「未測」要分出「這次沒走到」與「平台收不到這類證據」—— 後者重測也不會有。
 *  2. 門檻要標來源:客戶核定值與平台預設的顧問參考值不能混為一談。
 *  3. 受測組合與未變動的維度要明文列出,而不是留給讀者推斷結論有多普遍。
 */

type RawStep = Record<string, unknown>;
const st = (index: number, screen: string, action: string, obs?: Record<string, unknown>, extra: RawStep = {}): RawStep => ({
  index, screen, action, ...(obs ? { obs } : {}), ...extra,
});

const report = (opts: {
  steps?: RawStep[];
  job?: Record<string, unknown>;
  kbs?: Array<Record<string, unknown>>;
} = {}) =>
  buildStructuredReport({
    raw: { state: 'pass', task: '探索遊戲', steps: opts.steps ?? [st(0, '大廳', 'tap', undefined, { x: 5, y: 5 }), st(1, '選單', 'done')] },
    job: { jobId: 'job-test', ...(opts.job ?? {}) },
    app: { genre: 'slot' },
    ...(opts.kbs ? { kbs: opts.kbs as never } : {}),
  } as never);

describe('scope status distinguishes "not reached" from "cannot be detected"', () => {
  test('every non-executed scope carries a reason', () => {
    const r = report();
    for (const s of r.scope) {
      if (s.status === 'executed') expect(s.reason).toBeUndefined();
      else expect(s.reason?.zh.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('scopes the platform has no detector for are flagged, not silently "not tested"', () => {
    const r = report();
    // 這些範疇在引擎裡是寫死的 false:沒有偵測器,任何一次執行都不會有證據。
    const gaps = ['animation', 'audio', 'multiplayer', 'localization', 'save_load', 'payment', 'ai_behavior', 'physics'];
    for (const id of gaps) {
      const s = r.scope.find((x) => x.id === id)!;
      expect(s.detectable).toBe(false);
      expect(s.reason?.zh).toContain('平台限制');
    }
  });

  test('a scope that could have produced evidence is marked detectable', () => {
    const r = report();
    for (const id of ['functional', 'ui', 'graphics', 'performance', 'network', 'economy']) {
      expect(r.scope.find((x) => x.id === id)!.detectable).toBe(true);
    }
  });

  test('an executed scope needs no excuse', () => {
    const r = report();
    const functional = r.scope.find((x) => x.id === 'functional')!;
    expect(functional.status).toBe('executed');
    expect(functional.detectable).toBe(true);
    expect(functional.reason).toBeUndefined();
  });

  test('a selected-but-unreached scope reads differently from an unselected one', () => {
    const r = report();
    const selectedUnreached = r.scope.filter((s) => s.selected && s.status === 'not_executed' && s.detectable);
    for (const s of selectedUnreached) expect(s.reason?.zh).toContain('未產生對應證據');
    const unselected = r.scope.filter((s) => !s.selected && s.status === 'not_applicable' && s.detectable);
    for (const s of unselected) expect(s.reason?.zh).toContain('未選定');
  });
});

describe('threshold provenance survives the merge', () => {
  test('platform defaults are labelled as consultant reference values, not approved ones', () => {
    const r = report();
    expect(r.release.thresholdSources.length).toBeGreaterThan(0);
    const defaults = r.release.thresholdSources.filter((t) => t.origin === 'platform_default');
    expect(defaults.length).toBeGreaterThan(0);
    for (const t of defaults) {
      expect(t.note.zh).toContain('非客戶核定');
      expect(t.sources).toEqual([]);
      // 每個來源都對得回 release.thresholds 的值。
      expect(r.release.thresholds[t.key]).toBe(t.value);
    }
  });

  test('a knowledge-base threshold is attributed to the knowledge base that set it', () => {
    const r = report({
      kbs: [{ id: 'kb-1', name: 'Spec', reportSpec: { thresholds: { rtpMinSamples: 400 } } }],
    });
    const src = r.release.thresholdSources.find((t) => t.key === 'rtpMinSamples')!;
    expect(src.origin).toBe('knowledge_base');
    expect(src.value).toBe(400);
    expect(src.sources).toContain('kb-1');
  });

  test('a knowledge-base value that overrides a genre default says so', () => {
    // slot 樣板本身帶 rtpMinSamples 預設;知識庫覆寫時要標明是覆寫。
    const plain = report();
    const hadDefault = plain.release.thresholdSources.find((t) => t.key === 'rtpMinSamples')?.origin === 'platform_default';
    const r = report({ kbs: [{ id: 'kb-1', name: 'Spec', reportSpec: { thresholds: { rtpMinSamples: 999 } } }] });
    const src = r.release.thresholdSources.find((t) => t.key === 'rtpMinSamples')!;
    expect(src.origin).toBe('knowledge_base');
    if (hadDefault) expect(src.note.zh).toContain('覆寫');
  });

  test('threshold sources are sorted, so two reports diff cleanly', () => {
    const keys = report().release.thresholdSources.map((t) => t.key);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });
});

describe('claim scope states what the run does not prove', () => {
  test('the tested envelope lists each dimension and marks unobserved ones', () => {
    const r = report({ job: { platform: 'android', osVersion: '14', backend: 'device_farm' } });
    const byId = new Map(r.claimScope.envelope.map((e) => [e.id, e]));
    expect(byId.get('platform')).toMatchObject({ value: 'android', observed: true });
    expect(byId.get('environment')).toMatchObject({ value: 'device_farm', observed: true });
    // 讀不到語系時必須標為未觀測,不能留白讓人以為預設語系已驗。
    expect(byId.get('locale')).toMatchObject({ observed: false });
    expect(byId.get('locale')!.value).toContain('未觀測');
  });

  test('a single build cannot support a retest or regression claim', () => {
    const r = report();
    const build = r.claimScope.notVaried.find((n) => n.id === 'build')!;
    expect(build.note.zh).toContain('無法證明修正複驗');
  });

  test('an observed locale appears in the envelope but still proves nothing about copy', () => {
    const r = report({
      steps: [
        st(0, '大廳', 'tap', { locale: 'zh-Hans' }, { x: 5, y: 5 }),
        st(1, '選單', 'done', { locale: 'zh-Hans' }),
      ],
    });
    const locale = r.claimScope.envelope.find((e) => e.id === 'locale')!;
    expect(locale).toMatchObject({ value: 'zh-Hans', observed: true });

    // 讀得出語系 ≠ 文案驗過:仍然不得主張文案正確性。
    const note = r.claimScope.notVaried.find((n) => n.id === 'locale')!.note.zh;
    expect(note).toContain('zh-Hans');
    expect(note).toContain('未比對核定文案');
    expect(r.claimScope.statements.map((s) => s.zh).join(' ')).toContain('不構成語系正確性的驗證');
  });

  test('multiple observed locales are listed, and switching is acknowledged without overclaiming', () => {
    const r = report({
      steps: [
        st(0, '大廳', 'tap', { locale: 'en' }, { x: 5, y: 5 }),
        st(1, '設定', 'tap', { locale: 'zh-Hant' }, { x: 6, y: 6 }),
        st(2, '大廳', 'done', { locale: 'zh-Hant' }),
      ],
    });
    const locale = r.claimScope.envelope.find((e) => e.id === 'locale')!;
    expect(locale.observed).toBe(true);
    expect(locale.value).toContain('en');
    expect(locale.value).toContain('zh-Hant');

    const note = r.claimScope.notVaried.find((n) => n.id === 'locale')!.note.zh;
    expect(note).toContain('語系切換已發生');
    expect(note).toContain('未比對核定文案');
  });

  test('blank or whitespace locale readings are ignored rather than shown as a locale', () => {
    const r = report({
      steps: [
        st(0, '大廳', 'tap', { locale: '   ' }, { x: 5, y: 5 }),
        st(1, '選單', 'done', { locale: '' }),
      ],
    });
    expect(r.claimScope.envelope.find((e) => e.id === 'locale')!.observed).toBe(false);
  });

  test('a single device cannot support a cross-device adaptation claim', () => {
    const r = report();
    expect(r.claimScope.notVaried.find((n) => n.id === 'device')!.note.zh).toContain('不得主張跨機型');
  });

  test('without disconnect evidence, no weak-network claim is allowed', () => {
    const r = report();
    expect(r.scope.find((s) => s.id === 'network')!.status).not.toBe('executed');
    expect(r.claimScope.notVaried.some((n) => n.id === 'network')).toBe(true);
  });

  test('the statements spell out that a pass is not a clean bill of health', () => {
    const joined = report().claimScope.statements.map((s) => s.zh).join(' ');
    expect(joined).toContain('不表示同一畫面或功能沒有其他未被檢查的問題');
    expect(joined).toContain('僅適用於上列受測組合');
    // 有平台預設門檻時要額外聲明不得作為允收依據。
    expect(joined).toContain('不得作為跨專案標準');
  });

  test('the statistics cut-off is recorded so the numbers have an "as of" point', () => {
    const r = report({
      steps: [
        st(0, '大廳', 'tap', undefined, { x: 5, y: 5, at: '2026-11-07T01:00:00.000Z' }),
        st(1, '選單', 'done', undefined, { at: '2026-11-07T01:05:00.000Z' }),
      ],
    });
    expect(r.claimScope.cutoff).toBeTruthy();
  });

  test('the projection carries the envelope and the limits into the closure report', () => {
    const r = report();
    const t07 = r.qaDocs!.documents.find((d) => d.code === 'T07')!;
    const envelope = t07.tables.find((t) => t.id === 'claim_envelope')!;
    const limits = t07.tables.find((t) => t.id === 'claim_limits')!;
    expect(envelope.rows.length).toBe(r.claimScope.envelope.length);
    expect(limits.rows.length).toBe(r.claimScope.notVaried.length);

    // 未測理由表要帶出「平台可偵測」欄,否則工具缺口會被讀成「這次沒測到」。
    const notTested = t07.tables.find((t) => t.id === 'not_tested')!;
    expect(notTested.columns.map((c) => c.key)).toContain('detectable');
    const audio = notTested.rows.find((x) => x['scope'] === 'audio');
    if (audio) {
      expect(audio['detectable']).toBe('N');
      expect(audio['reason']).toContain('音訊');
    }
  });
});
