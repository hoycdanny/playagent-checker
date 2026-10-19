import { describe, expect, test } from 'vitest';
import {
  buildQueryString,
  classify,
  detectLevel,
  escapeInsightsRegex,
  getLogQuery,
  listLogSources,
  LogQueryError,
  normalizeQuery,
  parseInsightsTs,
  rowFromFields,
  startLogQuery,
  type SystemLogsPorts,
} from '../lambda/api/systemLogs.js';

const STAGE = 'PlayAgentDev';
const G = {
  api: `/aws/lambda/${STAGE}-ControlPlane-ApiFn1A2B3C`,
  engine: `/aws/lambda/${STAGE}-Execution-EngineFnABCDEF`,
  dispatcher: `/aws/lambda/${STAGE}-Scheduling-DispatcherFn99`,
  wsAuth: `/aws/lambda/${STAGE}-ControlPlane-WsAuthorizerXY`,
  logRetention: `/aws/lambda/${STAGE}-ControlPlane-LogRetentionaaa111`,
  runnerExp: `/playagent/${STAGE}/runner-exploration`,
  runnerWeb: `/playagent/${STAGE}/runner-web`,
  update: `/playagent/${STAGE}/update`,
  imgBuild: '/aws/codebuild/playagent-runner-build',
};

function fakePorts(over: Partial<SystemLogsPorts> = {}): SystemLogsPorts & { started: unknown[] } {
  const started: unknown[] = [];
  return {
    started,
    async listGroups() {
      return Object.values(G).map((logGroupName) => ({ logGroupName }));
    },
    async startQuery(input) { started.push(input); return 'q-123'; },
    async getQuery() { return { status: 'Complete', results: [] }; },
    ...over,
  };
}

describe('classify / listLogSources', () => {
  // 顯示文字由前端的語系表決定,後端只負責「這是哪一種服務」。所以這裡斷言的是穩定 id;
  // label 只是給舊前端與下載檔用的繁中預設值。
  test('每個服務對應到穩定 id 與種類', () => {
    expect(classify(G.api)).toEqual({ kind: 'lambda', id: 'api', label: '控制面 API' });
    expect(classify(G.engine).id).toBe('engine');
    expect(classify(G.dispatcher).id).toBe('dispatcher');
    expect(classify(G.wsAuth).id).toBe('ws-auth');
    expect(classify(G.runnerExp)).toMatchObject({ kind: 'ecs', id: 'runner-exploration' });
    expect(classify(G.runnerWeb).kind).toBe('ecs');
    expect(classify(G.update)).toMatchObject({ kind: 'codebuild', id: 'update' });
    expect(classify(G.imgBuild).kind).toBe('codebuild');
    expect(classify('/aws/lambda/Other-Thing').id).toBe('lambda-other');
    expect(classify('weird-group')).toMatchObject({ kind: 'other', id: 'other' });
  });

  test('每個 id 都有繁中預設名稱(下載檔與舊前端要靠它)', () => {
    for (const g of Object.values(G)) {
      expect(classify(g).label).not.toBe('');
    }
  });

  test('主要服務排在輔助 Lambda 之前,且去重', async () => {
    const ports = fakePorts({
      async listGroups() {
        return [{ logGroupName: G.logRetention }, { logGroupName: G.engine }, { logGroupName: G.api }, { logGroupName: G.api }];
      },
    });
    const sources = await listLogSources(ports);
    expect(sources.map((s) => s.logGroupName)).toEqual([G.api, G.engine, G.logRetention]);
    expect(sources).toHaveLength(3); // 去重
    expect(sources[0]!.sourceId).toBe('api');
    // 排序要看 id 而不是顯示字串,否則換語系就會換順序。
    expect(sources.map((s) => s.sourceId)).toEqual(['api', 'engine', 'log-retention']);
  });
});

describe('buildQueryString / escapeInsightsRegex', () => {
  test('無關鍵字:取欄位、依時間新到舊、限筆數', () => {
    const q = buildQueryString(null, 200);
    expect(q).toContain('fields @timestamp, @message, @logStream, @log');
    expect(q).toContain('sort @timestamp desc');
    expect(q).toContain('limit 200');
    expect(q).not.toContain('filter');
  });

  test('有關鍵字:加入 like 過濾,且特殊字元被跳脫', () => {
    const q = buildQueryString('a/b.c*', 50);
    expect(q).toContain('filter @message like /');
    expect(escapeInsightsRegex('a/b.c*')).toBe('a\\/b\\.c\\*');
    // 跳脫後不含未轉義的 / 以免提前結束正則
    const inside = q.split('like /')[1]!.split('/\n')[0]!;
    expect(inside).toBe('a\\/b\\.c\\*');
  });
});

describe('normalizeQuery', () => {
  const avail = [G.api, G.engine];
  test('預設 60 分鐘、limit 200、無來源(=全部)', () => {
    const n = normalizeQuery({}, avail, 1_000_000_000_000);
    expect(n.sources).toBeNull();
    expect(n.limit).toBe(200);
    expect(n.endMs - n.startMs).toBe(60 * 60_000);
  });

  test('limit 夾在 1..1000;minutes 夾在 1..10080', () => {
    expect(normalizeQuery({ limit: 99999 }, avail).limit).toBe(1000);
    expect(normalizeQuery({ limit: 0 }, avail).limit).toBe(1);
    const wide = normalizeQuery({ minutes: 999999 }, avail, 10_000_000_000);
    expect((wide.endMs - wide.startMs) / 60_000).toBe(7 * 24 * 60);
  });

  test('絕對 start/end 覆蓋相對時間', () => {
    const n = normalizeQuery({ start: 1000, end: 5000 }, avail);
    expect(n.startMs).toBe(1000);
    expect(n.endMs).toBe(5000);
  });

  test('只保留存在的來源;全部不存在則丟 LogQueryError', () => {
    expect(normalizeQuery({ sources: [G.api, 'nope'] }, avail).sources).toEqual([G.api]);
    expect(() => normalizeQuery({ sources: ['nope'] }, avail)).toThrow(LogQueryError);
  });

  test('關鍵字去頭尾空白;空白視為無', () => {
    expect(normalizeQuery({ pattern: '  hi  ' }, avail).pattern).toBe('hi');
    expect(normalizeQuery({ pattern: '   ' }, avail).pattern).toBeNull();
  });
});

describe('startLogQuery', () => {
  test('無來源時掃全部,帶正確時間與查詢字串', async () => {
    const ports = fakePorts();
    const { queryId, groupCount } = await startLogQuery(ports, { minutes: 15, pattern: 'boom' }, 2_000_000_000_000);
    expect(queryId).toBe('q-123');
    expect(groupCount).toBe(Object.keys(G).length);
    const input = ports.started[0] as { logGroupNames: string[]; startSec: number; endSec: number; queryString: string };
    expect(input.logGroupNames).toContain(G.api);
    expect(input.endSec - input.startSec).toBe(15 * 60);
    expect(input.queryString).toContain('like /boom/');
  });

  test('指定來源時只掃交集', async () => {
    const ports = fakePorts();
    await startLogQuery(ports, { sources: [G.engine, 'ghost'] });
    const input = ports.started[0] as { logGroupNames: string[] };
    expect(input.logGroupNames).toEqual([G.engine]);
  });

  test('沒有任何來源時丟 LogQueryError', async () => {
    const ports = fakePorts({ async listGroups() { return []; } });
    await expect(startLogQuery(ports, {})).rejects.toBeInstanceOf(LogQueryError);
  });
});

describe('detectLevel / parseInsightsTs / rowFromFields / getLogQuery', () => {
  test('等級盡力判斷', () => {
    expect(detectLevel('ERROR something failed')).toBe('ERROR');
    expect(detectLevel('Uncaught Exception: x')).toBe('ERROR');
    expect(detectLevel('[WARN] slow')).toBe('WARN');
    expect(detectLevel('INFO started')).toBe('INFO');
    expect(detectLevel('debug trace here')).toBe('DEBUG');
    expect(detectLevel('plain message')).toBeUndefined();
  });

  test('Insights UTC 時間字串轉 epoch 毫秒', () => {
    expect(parseInsightsTs('2026-10-13 14:00:00.000')).toBe(Date.parse('2026-10-13T14:00:00.000Z'));
    expect(parseInsightsTs('garbage')).toBe(0);
  });

  test('一列欄位對應成 LogRow;@log 去掉 accountId 前綴', () => {
    const row = rowFromFields([
      { field: '@timestamp', value: '2026-10-13 14:00:00.000' },
      { field: '@message', value: 'ERROR kaboom' },
      { field: '@logStream', value: 'exploration/abc' },
      { field: '@log', value: `137068253259:${G.engine}` },
      { field: '@ptr', value: 'ignored' },
    ]);
    expect(row.logGroup).toBe(G.engine);
    expect(row.sourceId).toBe('engine');
    expect(row.level).toBe('ERROR');
    expect(row.logStream).toBe('exploration/abc');
    expect(row.ts).toBe(Date.parse('2026-10-13T14:00:00.000Z'));
  });

  test('getLogQuery:Complete 視為 done,對應結果', async () => {
    const ports = fakePorts({
      async getQuery() {
        return {
          status: 'Complete',
          recordsMatched: 2,
          results: [[
            { field: '@timestamp', value: '2026-10-13 14:00:00.000' },
            { field: '@message', value: 'hello' },
            { field: '@log', value: `1:${G.api}` },
          ]],
        };
      },
    });
    const r = await getLogQuery(ports, 'q-1');
    expect(r.done).toBe(true);
    expect(r.status).toBe('Complete');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.sourceId).toBe('api');
    expect(r.recordsMatched).toBe(2);
  });

  test('getLogQuery:Running 尚未結束', async () => {
    const ports = fakePorts({ async getQuery() { return { status: 'Running', results: [] }; } });
    const r = await getLogQuery(ports, 'q-1');
    expect(r.done).toBe(false);
    expect(r.status).toBe('Running');
  });

  test('未知狀態對應為 Unknown 且視為結束', async () => {
    const ports = fakePorts({ async getQuery() { return { status: 'Weird', results: [] }; } });
    const r = await getLogQuery(ports, 'q-1');
    expect(r.status).toBe('Unknown');
    expect(r.done).toBe(true);
  });
});
