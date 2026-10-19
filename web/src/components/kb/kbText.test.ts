import { describe, expect, test } from 'vitest';
import { kbLang, kt, tr } from './kbText.ts';

const LOCALES = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'] as const;

/** 這張表的所有 key(以 kt 的型別為準,漏掉就編不過)。 */
const KEYS = [
  'title', 'intro', 'tabTemplates', 'tabMine', 'createBlank', 'search', 'showArchived',
  'view', 'edit', 'clone', 'duplicate', 'archive', 'unarchive', 'delete',
  'builtin', 'readOnly', 'archived', 'inUse', 'basedOn', 'revision', 'apps', 'jobs',
  'modules', 'mechanics', 'observe', 'metrics', 'charts', 'riskRules', 'releaseRules',
  'thresholds', 'specValues', 'scopes', 'noTemplatesMatch', 'noMine', 'cloneName', 'cloneSuffix',
  'editorCreate', 'editorEdit', 'editorView', 'secBasic', 'secKnowledge', 'secSpec', 'secDocs',
  'name', 'description', 'kind', 'kindCategory', 'kindScenario', 'genre', 'genreHint',
  'markdownHint', 'readOnlyHint', 'cancel', 'close', 'save', 'saving', 'create',
  'specIntro', 'specValuesHint', 'thresholdsHint', 'defaultLabel', 'yourValue',
  'inherited', 'inheritedGlobal', 'inheritedGenre',
  'customObserve', 'customObserveHint', 'customModules', 'customModulesHint',
  'extraScopes', 'add', 'remove', 'key', 'zhLabel', 'enLabel', 'hint', 'type', 'keywords',
  'core', 'disabledCount', 'noGenreForSpec', 'deleteConfirm', 'inUseTitle', 'inUseBody',
  'usedByApps', 'usedByJobs', 'otherTenants', 'archiveInstead', 'checking', 'archiveConfirm',
  'viewTask',
] as const;

describe('kbLang', () => {
  test('五種語系各自保留;認不出來退回英文', () => {
    for (const l of LOCALES) expect(kbLang(l)).toBe(l);
    expect(kbLang('de')).toBe('en');
  });
});

describe('kt', () => {
  // 這是這次改動的重點:原本只有繁中 / 英文,日文與韓文介面整頁都是英文。
  test('每個 key 在五種語系都有非空字串', () => {
    for (const k of KEYS) {
      for (const l of LOCALES) {
        const s = kt(k, l);
        expect(s, `${k} / ${l}`).toBeTruthy();
        expect(s.trim(), `${k} / ${l}`).not.toBe('');
      }
    }
  });

  test('日文與韓文不再等於英文(抓「沒翻、直接抄英文」)', () => {
    // 少數 key 的五語系本來就相同(如 App、WebSocket 這種專有名詞),所以看整體比例而不是逐條。
    const sameAsEn = (l: 'ja' | 'ko') =>
      KEYS.filter((k) => kt(k, l) === kt(k, 'en')).length;
    expect(sameAsEn('ja')).toBeLessThan(5);
    expect(sameAsEn('ko')).toBeLessThan(5);
  });

  test('英文字串不得殘留中日韓漢字(漏翻會被抓到)', () => {
    for (const k of KEYS) {
      expect(kt(k, 'en'), k).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  test('佔位符會被換掉', () => {
    expect(kt('disabledCount', 'zh-Hant', { n: 3 })).toBe('已停用 3 項');
    expect(kt('disabledCount', 'en', { n: 3 })).toBe('3 disabled');
    expect(kt('deleteConfirm', 'ja', { name: 'ABC' })).toContain('ABC');
    expect(kt('otherTenants', 'ko', { a: 2, j: 5 })).toContain('2');
    // 沒有未替換的佔位符殘留
    expect(kt('archiveConfirm', 'ja', { name: 'X' })).not.toContain('{name}');
  });
});

describe('tr(後端 { zh, en } 雙語資料)', () => {
  const v = { zh: '中文標籤', en: 'English label' };
  test('中文語系給 zh,其餘給 en(資料只有兩語,日韓拿英文)', () => {
    expect(tr(v, 'zh-Hant')).toBe('中文標籤');
    expect(tr(v, 'zh-Hans')).toBe('中文標籤');
    expect(tr(v, 'en')).toBe('English label');
    expect(tr(v, 'ja')).toBe('English label');
    expect(tr(v, 'ko')).toBe('English label');
  });

  test('沒有資料回空字串', () => {
    expect(tr(undefined, 'ja')).toBe('');
  });
});
