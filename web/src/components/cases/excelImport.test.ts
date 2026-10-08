import { describe, expect, it } from 'vitest';
import { caseToYaml, findHeaderRow, guessField, guessMap, rowsToCases, splitLines, suiteToYaml } from './excelImport.ts';

describe('guessField', () => {
  it('maps common Chinese / English headers', () => {
    expect(guessField('測試項目')).toBe('name');
    expect(guessField('案例編號')).toBe('id');
    expect(guessField('Test Steps')).toBe('steps');
    expect(guessField('預期結果')).toBe('expected');
    expect(guessField('前置條件')).toBe('precondition');
    expect(guessField('優先級')).toBe('priority');
    expect(guessField('功能模組')).toBe('module');
    expect(guessField('Expected Result')).toBe('expected');
  });
  it('does not mis-map unrelated headers', () => {
    expect(guessField('Notes')).toBeUndefined();
    expect(guessField('實際結果')).toBeUndefined();
    expect(guessField('Actual Result')).toBeUndefined();
    expect(guessField('')).toBeUndefined();
  });
});

describe('findHeaderRow', () => {
  it('skips title rows above the header', () => {
    const rows = [['XX 遊戲測試項目表'], [''], ['編號', '測試項目', '測試步驟', '預期結果'], ['TC-1', 'a', 'b', 'c']];
    expect(findHeaderRow(rows)).toBe(2);
  });
  it('returns -1 when no header looks right', () => {
    expect(findHeaderRow([['foo', 'bar'], ['1', '2']])).toBe(-1);
  });
});

describe('splitLines', () => {
  it('splits multi-line cells and strips numbering', () => {
    expect(splitLines('1. 啟動遊戲\n2、關閉公告\n3) 點 Spin')).toEqual(['啟動遊戲', '關閉公告', '點 Spin']);
  });
  it('splits inline numbered steps but not version numbers', () => {
    expect(splitLines('1.啟動遊戲 2.點開始')).toEqual(['啟動遊戲', '點開始']);
    expect(splitLines('升級到 1.2 版')).toEqual(['升級到 1.2 版']);
  });
  it('splits on semicolons', () => {
    expect(splitLines('看到大廳;有開始按鈕')).toEqual(['看到大廳', '有開始按鈕']);
  });
});

describe('rowsToCases', () => {
  const header = ['編號', '模組', '測試項目', '前置條件', '測試步驟', '預期結果', '優先級', '標籤'];
  it('one row per case', () => {
    const rows = [header, ['TC-001', '大廳', '進入大廳', '已安裝', '1. 啟動\n2. 關公告', '看到大廳', 'P1', 'smoke, lobby']];
    const cases = rowsToCases(rows, 0, guessMap(header));
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ row: 2, id: 'TC-001', name: 'TC-001 進入大廳', module: '大廳', priority: 'P1', precondition: '已安裝', steps: ['啟動', '關公告'], expected: ['看到大廳'], tags: ['smoke', 'lobby'] });
  });
  it('merges one-step-per-row continuation rows and skips blank rows', () => {
    const rows = [
      header,
      ['TC-001', '大廳', '進入大廳', '', '啟動遊戲', '', 'P1', ''],
      ['', '', '', '', '關閉公告', '看到大廳', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['TC-002', '老虎機', '轉一次', '', '點 Spin', '轉輪轉動', 'P2', ''],
    ];
    const cases = rowsToCases(rows, 0, guessMap(header));
    expect(cases.map((c) => c.name)).toEqual(['TC-001 進入大廳', 'TC-002 轉一次']);
    expect(cases[0]!.steps).toEqual(['啟動遊戲', '關閉公告']);
    expect(cases[0]!.expected).toEqual(['看到大廳']);
    expect(cases[1]!.row).toBe(5);
  });
  it('does not prefix purely numeric row numbers to the name', () => {
    const h = ['項次', '測試項目'];
    expect(rowsToCases([h, ['3', '轉一次']], 0, guessMap(h))[0]!.name).toBe('轉一次');
  });
});

describe('caseToYaml', () => {
  it('writes a task block with precondition, numbered steps and expected result', () => {
    const header = ['編號', '測試項目', '前置條件', '測試步驟', '預期結果', '優先級', '標籤'];
    const rows = [header, ['TC-9', '登入: 正常帳號', '已安裝 #1', '1. 輸入帳號 ${TEST_USER}\n2. 點登入', '進入大廳;顯示暱稱', 'P1', 'smoke']];
    const [c] = rowsToCases(rows, 0, guessMap(header));
    const yaml = caseToYaml(c!, 'app-1', { source: 'cases.xlsx#2' });
    expect(yaml).toBe(
      [
        'name: "TC-9 登入: 正常帳號"',
        'app: app-1',
        'caseRef: TC-9',
        'priority: P1',
        'precondition: "已安裝 #1"',
        'task: |',
        '  前置條件: 已安裝 #1',
        '  1. 輸入帳號 ${TEST_USER}',
        '  2. 點登入',
        '  預期結果: 進入大廳; 顯示暱稱',
        'assertions:',
        '  - 進入大廳',
        '  - 顯示暱稱',
        'tags: [smoke]',
        'source: cases.xlsx#2',
        '',
      ].join('\n'),
    );
  });
  it('quotes values YAML would misread', () => {
    const header = ['測試項目', '優先級'];
    const [c] = rowsToCases([header, ['- 開頭的名稱', '1']], 0, guessMap(header));
    const yaml = caseToYaml(c!, 'a');
    expect(yaml).toContain('name: "- 開頭的名稱"');
    expect(yaml).toContain('priority: "1"');
  });
  it('uses the case name as the task when there are no steps', () => {
    const header = ['測試項目'];
    const [c] = rowsToCases([header, ['確認大廳音樂播放']], 0, guessMap(header));
    expect(caseToYaml(c!, 'a')).toContain('task: |\n  1. 確認大廳音樂播放\n');
  });
});

// ── 測試目的欄 + 整份 = 一個測試套件 ─────────────────────────────────────

describe('purpose 欄(測試目的)', () => {
  it('認得「測試目的」並和「項目」分開', () => {
    expect(guessField('測試目的')).toBe('purpose');
    expect(guessField('項目')).toBe('name');
    const m = guessMap(['編號', '類別', '項目', '測試目的', '步驟', '預期結果']);
    expect(m.id).toBe(0);
    expect(m.category).toBe(1);
    expect(m.name).toBe(2);
    expect(m.purpose).toBe(3);
    expect(m.steps).toBe(4);
    expect(m.expected).toBe(5);
  });

  it('目的會進到案例與任務描述', () => {
    const rows = [
      ['編號', '類別', '項目', '測試目的', '步驟', '預期結果'],
      ['184', '中央畫面區', '神秘商人', '神秘商人頁面', '1.大廳點擊神秘商人ICON\n2.檢視神秘商人頁面', '1.圖片、文字無破圖模糊'],
    ];
    const [c] = rowsToCases(rows, 0, guessMap(rows[0]!));
    expect(c?.purpose).toBe('神秘商人頁面');
    expect(c?.steps).toEqual(['大廳點擊神秘商人ICON', '檢視神秘商人頁面']);
    const yaml = caseToYaml(c!, 'app-1');
    expect(yaml).toContain('purpose: 神秘商人頁面');
    expect(yaml).toContain('測試目的: 神秘商人頁面');
  });
});

describe('suiteToYaml(整份 = 一個測試任務)', () => {
  const rows = [
    ['編號', '類別', '項目', '測試目的', '步驟', '預期結果'],
    ['184', '中央畫面區', '神秘商人', '神秘商人頁面', '1.點 ICON\n2.檢視頁面', '1.無破圖'],
    ['185', '中央畫面區', '神秘商人', '檢視詳細', '1.點任意品項', '1.可正常開啟/關閉'],
  ];
  const items = rowsToCases(rows, 0, guessMap(rows[0]!));

  it('一份表只產生一個案例,並保留每個項目', () => {
    const yaml = suiteToYaml(items, 'app-1', { name: '測試項目表' });
    expect(yaml).toContain('kind: suite');
    expect(yaml).toContain('itemCount: 2');
    // 結構化項目清單:編號、標題、步驟、預期都在
    expect(yaml).toContain('- ref: "184"');
    expect(yaml).toContain('- ref: "185"');
    expect(yaml).toContain('    purpose: 神秘商人頁面');
    expect(yaml).toContain('      - 點 ICON');
    expect(yaml).toContain('      - 無破圖');
  });

  it('task 是整份清單(給執行引擎的單一目標)', () => {
    const yaml = suiteToYaml(items, 'app-1', { name: '測試項目表' });
    const task = yaml.slice(yaml.indexOf('task: |'), yaml.indexOf('items:'));
    expect(task).toContain('2 個測試項目');
    expect(task).toContain('[184]');
    expect(task).toContain('[185]');
    expect(task).toContain('預期: 無破圖');
  });

  it('含引號/冒號的文字不會壞掉 YAML', () => {
    const tricky = rowsToCases(
      [['編號', '項目', '步驟', '預期結果'], ['1', 'a: b', '點 "確定"', '顯示: ok']],
      0,
      guessMap(['編號', '項目', '步驟', '預期結果']),
    );
    const yaml = suiteToYaml(tricky, 'app-1', { name: 'x' });
    // 冒號會讓純量歧義 → 必須加引號;句中的雙引號在 YAML 純量裡合法,不必轉義。
    expect(yaml).toContain('"a: b"');
    expect(yaml).toContain('"顯示: ok"');
    expect(yaml).toContain('- 點 "確定"');
  });
});
