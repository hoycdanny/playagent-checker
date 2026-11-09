import { describe, expect, test } from 'vitest';
import {
  applyNetem,
  clearNetem,
  confirmsLatency,
  netemPlan,
  shapingCommands,
} from '../../agent/netemShaper.mjs';
import { parseNetworkCondition } from '../../agent/networkConditions.mjs';

/**
 * Android 容器的流量塑形。
 *
 * 這組測試守三件事,每一件都對應一個會讓報告說謊的失效模式:
 *   1. adb 控制通道要排除在塑形之外 —— 不排除的話 offline 會切斷連線、限速會讓
 *      截圖逾時,而兩者看起來都像「遊戲在弱網下壞掉」,是假的失敗。
 *   2. 做不到的項目要指名 —— 下行找不到 veth 就限不了速,那一項不能算已施加。
 *   3. 量到 RTT 不等於驗過 —— 要求 1000ms 卻量到 3ms 必須是未確認。
 */

/**
 * 假的命令執行器:記下被呼叫的命令,並依樣式回覆。
 * **先命中者勝** —— 要覆寫 healthy() 的某一條回覆,必須放在它前面。
 */
function fakeRun(replies: Array<{ match: RegExp; code?: number; stdout?: string; stderr?: string }> = []) {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    for (const r of replies) {
      if (r.match.test(line)) {
        return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

/** 一組「容器正常、veth 找得到、ping 量得到」的預設回覆。 */
const healthy = (rttMs = 1000) => [
  { match: /^docker inspect/, stdout: '4242\n' },
  { match: /nsenter .* cat \/sys\/class\/net\/eth0\/iflink/, stdout: '77\n' },
  { match: /^ip -o link/, stdout: '1: lo: <LOOPBACK>\n77: veth9c1a2b@if76: <BROADCAST>\n' },
  { match: /nsenter .* ip route/, stdout: 'default via 172.17.0.1 dev eth0\n' },
  { match: /nsenter .* ping/, stdout: `rtt min/avg/max/mdev = ${rttMs}/${rttMs}/${rttMs}/0.1 ms\n` },
];

describe('netemPlan:條件 → tc 參數', () => {
  test('延遲與丟包都進容器側出向(丟包是相對瀏覽器後端的主要差異)', () => {
    const plan = netemPlan(parseNetworkCondition('latency=800,loss=5')!);
    expect(plan.containerEgress).toEqual(['delay', '800ms', 'loss', '5%']);
    expect(plan.applied).toMatchObject({ latencyMs: 800, lossPct: 5 });
    // 丟包做得到,所以不該出現在 unsupported 裡
    expect(plan.unsupported.map((u) => u.key)).not.toContain('lossPct');
  });

  test('下行走主機側 veth,上行走容器側 —— 方向不同是兩個 qdisc', () => {
    const plan = netemPlan(parseNetworkCondition('down=400,up=200')!);
    expect(plan.containerEgress).toEqual(['rate', '200kbit']);
    expect(plan.hostEgress).toEqual(['rate', '400kbit']);
  });

  test('延遲只在容器側套一次,不在兩側重複(否則 RTT 會變兩倍)', () => {
    const plan = netemPlan(parseNetworkCondition('latency=500,down=400')!);
    expect(plan.containerEgress).toEqual(['delay', '500ms']);
    expect(plan.hostEgress).toEqual(['rate', '400kbit']);
    expect(plan.hostEgress!.join(' ')).not.toContain('delay');
  });

  test('離線以全丟封包實作,並把「介面仍為 up」列為做不到的部分', () => {
    const plan = netemPlan(parseNetworkCondition('offline')!);
    expect(plan.containerEgress).toEqual(['loss', '100%']);
    expect(plan.applied.offline).toBe(true);
    const link = plan.unsupported.find((u) => u.key === 'offline.linkDown');
    expect(link, '離線與鏈路斷開的差別必須寫出來').toBeDefined();
    expect(link!.reason).toContain('逾時');
  });

  test('同時給離線與丟包時以離線為準,不疊加', () => {
    const plan = netemPlan(parseNetworkCondition('offline,loss=5')!);
    expect(plan.containerEgress).toEqual(['loss', '100%']);
    expect(plan.applied.lossPct).toBeUndefined();
  });

  test('applied 只放條件維度,不混進介面名之類的診斷資訊', () => {
    // applied 會原樣進報告,而報告據它主張「這些條件下驗過」。
    const plan = netemPlan(parseNetworkCondition('latency=100,down=400,up=200,loss=1')!);
    expect(Object.keys(plan.applied).sort()).toEqual(['downloadKbps', 'latencyMs', 'lossPct', 'uploadKbps']);
    for (const v of Object.values(plan.applied)) {
      expect(['number', 'boolean']).toContain(typeof v);
    }
  });
});

describe('shapingCommands:adb 控制通道必須不受塑形', () => {
  const cmds = () => shapingCommands('eth0', ['delay', '900ms']).map((a) => a.join(' '));

  test('root 是 prio,netem 掛在第三個 band', () => {
    const lines = cmds();
    expect(lines[0]).toContain('root handle 1: prio bands 3');
    expect(lines[1]).toContain('parent 1:3');
    expect(lines[1]).toContain('netem delay 900ms');
  });

  test('priomap 全導向 netem 的 band:沒被 filter 命中的流量一定要受塑形', () => {
    // prio 預設依 TOS 把多數封包放進 band 0。沿用預設會讓遊戲流量不受塑形,
    // 跟需求正好相反 —— 那會讓報告主張一個完全沒生效的條件。
    const priomap = cmds()[0]!.split('priomap ')[1]!.trim().split(/\s+/);
    expect(priomap).toHaveLength(16);
    expect(new Set(priomap)).toEqual(new Set(['2']));
  });

  test('5555 的來源與目的都導到不受限的 band', () => {
    const lines = cmds();
    const filters = lines.filter((l) => l.includes('filter add'));
    expect(filters).toHaveLength(2);
    expect(filters.some((l) => /match ip sport 5555 0xffff flowid 1:1/.test(l))).toBe(true);
    expect(filters.some((l) => /match ip dport 5555 0xffff flowid 1:1/.test(l))).toBe(true);
  });

  test('明確傳 0 可以關掉排除(測試或非 adb 情境用)', () => {
    const lines = shapingCommands('eth0', ['delay', '10ms'], 0).map((a) => a.join(' '));
    expect(lines.filter((l) => l.includes('filter add'))).toHaveLength(0);
  });

  test('沒有 netem 參數時不產生任何命令', () => {
    expect(shapingCommands('eth0', [])).toEqual([]);
  });
});

describe('applyNetem:塑形只套進容器的網路命名空間', () => {
  test('容器側命令全部走 nsenter,主機側只動 veth', async () => {
    const { run, calls } = fakeRun(healthy());
    const res = await applyNetem({
      cond: parseNetworkCondition('latency=1000,down=400')!,
      run,
    });
    expect(res.ok).toBe(true);
    // 容器側:進 netns
    expect(calls.some((c) => /^nsenter -t 4242 -n tc qdisc add dev eth0 root/.test(c))).toBe(true);
    // 主機側:只對解析出來的 veth 下手,絕對不能碰主機的對外介面
    expect(calls.some((c) => /^tc qdisc add dev veth9c1a2b root/.test(c))).toBe(true);
    for (const c of calls) {
      expect(c, '主機層的 tc 只能套在 veth 上').not.toMatch(/^tc qdisc add dev (eth0|ens5|enX0) /);
    }
    expect(res.hostIface).toBe('veth9c1a2b');
  });

  test('核心缺 sch_netem → 施加失敗,不靜默降級', async () => {
    const { run } = fakeRun([{ match: /^modprobe/, code: 1, stderr: 'module not found' }]);
    const res = await applyNetem({ cond: parseNetworkCondition('latency=500')!, run });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('sch_netem');
    expect(res.applied).toEqual({});
  });

  test('取不到容器 PID → 施加失敗並說明原因', async () => {
    const { run } = fakeRun([{ match: /^docker inspect/, code: 1, stderr: 'No such object' }]);
    const res = await applyNetem({ cond: parseNetworkCondition('latency=500')!, run });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('網路命名空間');
  });

  test('容器側套用失敗 → 先清乾淨再回報(半套上的 qdisc 比沒套更危險)', async () => {
    const { run, calls } = fakeRun([
      { match: /nsenter .* tc qdisc add/, code: 2, stderr: 'RTNETLINK answers: Operation not supported' },
      ...healthy(),
    ]);
    const res = await applyNetem({ cond: parseNetworkCondition('latency=500')!, run });
    expect(res.ok).toBe(false);
    expect(res.applied).toEqual({});
    expect(calls.some((c) => /tc qdisc del dev eth0 root/.test(c))).toBe(true);
  });

  test('找不到主機側 veth → 下行列為做不到,但延遲仍算施加成功', async () => {
    const { run } = fakeRun([
      // iflink 查得到,但主機上沒有同 ifindex 的介面(覆寫要放在 healthy 之前)
      { match: /^ip -o link/, stdout: '1: lo: <LOOPBACK>\n9: docker0: <BROADCAST>\n' },
      ...healthy(),
    ]);
    const res = await applyNetem({
      cond: parseNetworkCondition('latency=1000,down=400')!,
      run,
    });
    expect(res.ok).toBe(true);
    expect(res.applied.latencyMs).toBe(1000);
    // 關鍵:沒限到速就不能出現在 applied 裡
    expect(res.applied.downloadKbps).toBeUndefined();
    const miss = res.unsupported.find((u) => u.key === 'downloadKbps');
    expect(miss, '下行限不了速必須指名').toBeDefined();
    expect(miss!.reason).toContain('veth');
  });

  test('量測確認延遲生效 → verified 為真,並帶出實測與基準值', async () => {
    const { run } = fakeRun(healthy(1000));
    const res = await applyNetem({ cond: parseNetworkCondition('latency=1000')!, run });
    expect(res.ok).toBe(true);
    expect(res.measuredRttMs).toBe(1000);
    expect(res.verified).toBe(true);
  });

  test('tc 回 0 但量到的 RTT 遠低於要求 → 已施加但未確認', async () => {
    // 這是最危險的情況:工具回報成功,條件其實沒套到實際路徑上。
    const { run } = fakeRun(healthy(3));
    const res = await applyNetem({ cond: parseNetworkCondition('latency=1000')!, run });
    expect(res.ok).toBe(true);
    expect(res.measuredRttMs).toBe(3);
    expect(res.verified, '量到 3ms 不能算 1000ms 驗過').toBe(false);
  });

  test('關掉量測 → verified 為假(沒有佐證不等於驗過)', async () => {
    const { run } = fakeRun(healthy(1000));
    const res = await applyNetem({ cond: parseNetworkCondition('latency=1000')!, run, measure: false });
    expect(res.ok).toBe(true);
    expect(res.measuredRttMs).toBeUndefined();
    expect(res.verified).toBe(false);
  });

  test('離線時不量 RTT(全丟之下 ping 不回來,量不到不是驗證失敗)', async () => {
    const { run, calls } = fakeRun(healthy());
    const res = await applyNetem({ cond: parseNetworkCondition('offline')!, run });
    expect(res.ok).toBe(true);
    expect(res.applied.offline).toBe(true);
    // 施加後不該再 ping;施加前的基準量測可以有
    const pings = calls.filter((c) => /ping/.test(c));
    expect(pings.length).toBeLessThanOrEqual(1);
  });
});

describe('confirmsLatency:量測是否足以確認延遲', () => {
  test('量值接近要求值 → 確認', () => {
    expect(confirmsLatency({ latencyMs: 1000, measuredRttMs: 1010, baselineRttMs: 2 })).toBe(true);
    expect(confirmsLatency({ latencyMs: 1000, measuredRttMs: 700 })).toBe(true);
  });

  test('量值遠低於要求值 → 不確認(條件很可能沒生效)', () => {
    expect(confirmsLatency({ latencyMs: 1000, measuredRttMs: 3 })).toBe(false);
    expect(confirmsLatency({ latencyMs: 1000, measuredRttMs: 400 })).toBe(false);
  });

  test('量值離譜地高也不確認', () => {
    expect(confirmsLatency({ latencyMs: 100, measuredRttMs: 5000 })).toBe(false);
  });

  test('沒量測、沒要求延遲都回假 ——「沒有佐證」不等於「驗過」', () => {
    expect(confirmsLatency({ latencyMs: 1000 })).toBe(false);
    expect(confirmsLatency({ measuredRttMs: 1000 })).toBe(false);
    expect(confirmsLatency({})).toBe(false);
  });
});

describe('clearNetem:兩側都要清', () => {
  test('容器側與主機側 veth 的 qdisc 都刪掉', async () => {
    const { run, calls } = fakeRun(healthy());
    await clearNetem({ run });
    expect(calls.some((c) => /nsenter -t 4242 -n tc qdisc del dev eth0 root/.test(c))).toBe(true);
    expect(calls.some((c) => /^tc qdisc del dev veth9c1a2b root/.test(c))).toBe(true);
  });

  test('容器已經不在了也不丟例外(收尾不該讓任務失敗)', async () => {
    const { run } = fakeRun([{ match: /^docker inspect/, code: 1, stderr: 'No such object' }]);
    await expect(clearNetem({ run })).resolves.toEqual({ ok: false });
  });
});
