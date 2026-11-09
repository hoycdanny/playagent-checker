/**
 * Android 容器的流量塑形(Linux tc netem)。
 *
 * 為什麼不能直接在主機上套 tc:
 *   Redroid 容器跑在 EC2 主機上,而 explorationRunner **也**跑在同一台主機上 ——
 *   它要連 Bedrock 推論、把截圖與報告傳上 S3。在主機的對外介面套 netem 會把
 *   runner 自己的流量一起劣化:VLM 逾時、證據傳不上去,然後報告會把這些算成
 *   「遊戲在弱網下壞掉」。那是假的失敗,比測不到更糟。
 *
 *   所以塑形只套進**容器的網路命名空間**(nsenter -n),主機自己的流量不受影響。
 *
 * 與瀏覽器後端的能力差異(這是這一層存在的主要價值):
 *   netem 做得到封包遺失率,CDP 做不到。弱網測項裡「掉包 X%」這類條件在網頁後端
 *   只能回報 unsupported,在 Android 容器可以真的施加。
 *
 * 方向的處理:
 *   容器 eth0 的 root qdisc 只管得到**出向**(上行)。下行要在主機側的 veth 對端
 *   套 qdisc(主機 → 容器 也是那個介面的出向)。兩邊都套延遲會讓 RTT 變兩倍,
 *   所以延遲只在容器側套一次。
 *
 * **adb 控制通道必須排除在塑形之外。**
 *   這不是最佳化,是這個功能能不能用的前提。adb 走 host → 容器的 5555 埠,
 *   容器的回應封包從 eth0 出去 —— 跟遊戲流量走同一個 qdisc。不排除的話:
 *     - offline(全丟)會直接切斷 adb,任務整個失敗,而表面上看起來像
 *       「遊戲在弱網下崩潰」;那是假的失敗。
 *     - 限速會讓每張截圖(數百 KB)花上十幾秒,探索迴圈慢到逾時。
 *   所以 qdisc 用 prio 分兩條路:5555 的封包走不受限的 band,其餘走 netem。
 *
 * 失敗一律回報,不靜默降級:套不上就是 ok=false,報告據此不主張該條件已驗。
 */

/** adb 控制通道的埠;這個埠的流量不受塑形影響。 */
const ADB_PORT = 5555;

/** netem 的 rate 單位用 kbit;kbps(kilobit/s)在這裡視為同一個量。 */
const KBIT = 'kbit';

/**
 * 條件 → netem 施加計畫。
 *
 * 純函式:只算出要下哪些 tc 參數、哪一項做不到,不碰系統。
 * 這樣命令的組法可以在沒有 root、沒有 docker 的環境下測。
 *
 * @param cond parseNetworkCondition() 的輸出(已正規化)
 * @returns {{
 *   containerEgress: string[] | null,
 *   hostEgress: string[] | null,
 *   applied: object,
 *   unsupported: Array<{key:string, reason:string}>,
 * }}
 */
export function netemPlan(cond) {
  const applied = {};
  const unsupported = [];
  /** 容器側 eth0 的 netem 參數(出向:上行、延遲、丟包)。 */
  const container = [];

  // 離線:netem 沒有「拔網路線」這個旋鈕,最接近的是全丟。
  // 兩者對受測程式不等價,必須講清楚 —— 全丟之下介面仍是 up,Android 的連線狀態
  // 還是「已連線」,程式看到的是逾時而不是「無網路」事件。測「斷網提示」的案例
  // 會因此測不到它想測的東西,所以這一點進 unsupported。
  if (cond.offline === true) {
    container.push('loss', '100%');
    applied.offline = true;
    unsupported.push({
      key: 'offline.linkDown',
      reason: '以全丟封包模擬離線;介面仍為 up,Android 連線狀態不會轉為「無網路」,程式收到的是逾時而非斷網事件',
    });
  }

  if (cond.latencyMs > 0) {
    // 延遲只在容器出向套一次。主機側再套一次會讓往返各加一遍,實際 RTT 變成兩倍。
    container.unshift('delay', `${num(cond.latencyMs)}ms`);
    applied.latencyMs = num(cond.latencyMs);
  }

  // 丟包:netem 做得到,這是相對瀏覽器後端的主要差異。
  // 已經因為 offline 設了 loss 100% 時不再疊加(以離線為準)。
  if (cond.lossPct > 0 && cond.offline !== true) {
    container.push('loss', `${num(cond.lossPct)}%`);
    applied.lossPct = num(cond.lossPct);
  }

  // 上行:容器出向限速。
  if (cond.uploadKbps > 0) {
    container.push('rate', `${num(cond.uploadKbps)}${KBIT}`);
    applied.uploadKbps = num(cond.uploadKbps);
  }

  // 下行:主機 → 容器,要套在主機側 veth 的出向,是另一個 qdisc。
  const host = cond.downloadKbps > 0 ? ['rate', `${num(cond.downloadKbps)}${KBIT}`] : null;
  if (host) applied.downloadKbps = num(cond.downloadKbps);

  return {
    containerEgress: container.length ? container : null,
    hostEgress: host,
    applied,
    unsupported,
  };
}

/**
 * 量到的 RTT 是否足以確認延遲真的生效。
 *
 * 判準刻意寬鬆下界、寬鬆上界,但要求延遲「看得見」:
 *   - 下界取要求值的一半 —— ICMP 與 TCP 的路徑不完全相同,抓太緊會把真的生效的
 *     情況誤判成沒生效。
 *   - 上界留兩倍加基準加 50ms —— 容器啟動初期的抖動不該算驗證失敗。
 * 落在區間外(尤其遠低於要求值)就回 false:那通常代表 qdisc 沒套到實際路徑上。
 *
 * 沒有要求延遲、或量不到 RTT,都回 false —— 「沒有佐證」不等於「驗過」。
 */
export function confirmsLatency({ baselineRttMs, measuredRttMs, latencyMs }) {
  if (typeof measuredRttMs !== 'number' || !Number.isFinite(measuredRttMs)) return false;
  if (typeof latencyMs !== 'number' || latencyMs <= 0) return false;
  const base = typeof baselineRttMs === 'number' && Number.isFinite(baselineRttMs) ? baselineRttMs : 0;
  return measuredRttMs >= latencyMs * 0.5 && measuredRttMs <= latencyMs * 2 + base + 50;
}

/**
 * 組出某個介面上的完整 tc 命令序列(純函式,不碰系統)。
 *
 * 結構:
 *   root 是 prio,priomap 把**所有** TOS 都導到第三個 band(1:3),那個 band 掛 netem。
 *   然後用 u32 filter 把 adb 的埠(來源或目的)導到 1:1 —— 第一個 band 沒掛任何
 *   qdisc,等於不受限。
 *
 * 為什麼 priomap 全填 2:prio 預設會依 TOS 把大多數封包放進 band 0,
 * 那會讓「沒有被 filter 命中的流量」反而不受塑形 —— 跟需求正好相反。
 *
 * @param dev        介面名
 * @param netemArgs  netem 參數(netemPlan 的輸出)
 * @param exemptPort 不受塑形的埠(預設 adb 的 5555)
 * @returns {string[][]} 依序執行的 tc 參數陣列
 */
export function shapingCommands(dev, netemArgs, exemptPort = ADB_PORT) {
  if (!dev || !Array.isArray(netemArgs) || netemArgs.length === 0) return [];
  const port = Number(exemptPort);
  const cmds = [
    ['qdisc', 'add', 'dev', dev, 'root', 'handle', '1:', 'prio', 'bands', '3',
      'priomap', ...Array(16).fill('2')],
    ['qdisc', 'add', 'dev', dev, 'parent', '1:3', 'handle', '30:', 'netem', ...netemArgs],
  ];
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    // 來源與目的都排除:同一支函式用在容器側(回應封包 sport=5555)與
    // 主機側 veth(請求封包 dport=5555),兩邊命中的欄位不同。
    for (const [i, field] of ['sport', 'dport'].entries()) {
      cmds.push(['filter', 'add', 'dev', dev, 'protocol', 'ip', 'parent', '1:',
        'prio', String(i + 1), 'u32', 'match', 'ip', field, String(port), '0xffff', 'flowid', '1:1']);
    }
  }
  return cmds;
}

/** 只接受有限數字,並去掉小數尾巴以外的雜訊(值來自已正規化的條件,這裡是第二道防線)。 */
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`netem 參數不是正數:${v}`);
  // tc 不吃過長的小數;保留兩位足夠表達 2.5% 這類條件。
  return Math.round(n * 100) / 100;
}

/**
 * 施加塑形。
 *
 * @param opts.container   容器名(Redroid 容器,預設 'android')
 * @param opts.cond        parseNetworkCondition() 的輸出
 * @param opts.run         注入的執行器 (cmd, args) => Promise<{ code, stdout, stderr }>
 * @param opts.measure     是否在施加前後量 RTT 當獨立佐證(預設 true)
 * @param opts.exemptPort  不受塑形的埠(預設 adb 的 5555;設 0 代表不排除任何埠)
 * @returns {{ applied, unsupported, ok, error?, measuredRttMs?, baselineRttMs?, verified?, hostIface? }}
 */
export async function applyNetem({ container = 'android', cond, run, measure = true, exemptPort = ADB_PORT }) {
  const plan = netemPlan(cond);
  const unsupported = [...plan.unsupported];

  if (!plan.containerEgress && !plan.hostEgress) {
    return { applied: {}, unsupported, ok: false, error: '條件解析後沒有任何可施加的項目' };
  }

  // netem 需要 sch_netem 核心模組。AMI 沒帶的話整個施加必須失敗,
  // 不能退回「沒有條件的普通執行」還讓報告以為條件生效了。
  const mod = await run('modprobe', ['sch_netem']);
  if (mod.code !== 0) {
    return {
      applied: {},
      unsupported,
      ok: false,
      error: `核心缺少 sch_netem 模組,無法施加流量塑形:${trim(mod.stderr)}`,
    };
  }

  const pidRes = await run('docker', ['inspect', '-f', '{{.State.Pid}}', container]);
  const pid = Number(trim(pidRes.stdout));
  if (pidRes.code !== 0 || !Number.isInteger(pid) || pid <= 0) {
    return {
      applied: {},
      unsupported,
      ok: false,
      error: `取不到容器 ${container} 的 PID,無法進入其網路命名空間:${trim(pidRes.stderr) || trim(pidRes.stdout)}`,
    };
  }

  const inNs = (args) => run('nsenter', ['-t', String(pid), '-n', ...args]);
  const applied = {};

  // 施加前的基準 RTT:之後拿來對照,證明延遲真的生效(而不是只「下了命令」)。
  let baselineRttMs;
  if (measure && plan.containerEgress) {
    baselineRttMs = await pingRttMs(inNs);
  }

  // --- 容器側(出向:延遲 / 丟包 / 上行)---
  if (plan.containerEgress) {
    for (const args of shapingCommands('eth0', plan.containerEgress, exemptPort)) {
      const res = await inNs(['tc', ...args]);
      if (res.code !== 0) {
        // 半套上的 qdisc 比沒套上更危險:流量可能已經被劣化,但報告會以為沒施加。
        // 所以失敗就整個清掉,回到乾淨狀態再回報失敗。
        await clearNetem({ container, run }).catch(() => {});
        return {
          applied: {},
          unsupported,
          ok: false,
          error: `容器側 tc 套用失敗(${args.slice(0, 3).join(' ')}):${trim(res.stderr) || trim(res.stdout)}`,
        };
      }
    }
    for (const k of ['latencyMs', 'lossPct', 'uploadKbps', 'offline']) {
      if (plan.applied[k] !== undefined) applied[k] = plan.applied[k];
    }
  }

  // --- 主機側 veth(下行限速)---
  let hostIface;
  if (plan.hostEgress) {
    const iface = await hostVethOf(inNs, run);
    if (!iface) {
      // 找不到對端就把下行列為做不到。這比「悄悄沒限速」重要:
      // 案例要求了 400kbps 下行,報告必須知道那一項沒生效。
      unsupported.push({
        key: 'downloadKbps',
        reason: '找不到容器 eth0 在主機側的 veth 對端,無法對下行方向限速(上行與延遲不受影響)',
      });
    } else {
      let failed = null;
      for (const args of shapingCommands(iface, plan.hostEgress, exemptPort)) {
        const res = await run('tc', args);
        if (res.code !== 0) { failed = trim(res.stderr) || trim(res.stdout); break; }
      }
      if (failed) {
        await run('tc', ['qdisc', 'del', 'dev', iface, 'root']).catch(() => {});
        unsupported.push({
          key: 'downloadKbps',
          reason: `主機側 veth(${iface})限速失敗:${failed}`,
        });
      } else {
        applied.downloadKbps = plan.applied.downloadKbps;
        hostIface = iface;
      }
    }
  }

  // 至少要有一項真的套上,否則這次不算施加成功。
  // `applied` 只放條件維度,所以這裡直接數它就行 —— 介面名之類的診斷資訊不在裡面。
  if (Object.keys(applied).length === 0) {
    return { applied: {}, unsupported, ok: false, error: '所有要求的項目都沒有成功施加' };
  }

  // 施加後的 RTT:有延遲要求時才有對照意義。
  let measuredRttMs;
  if (measure && applied.latencyMs && !applied.offline) {
    measuredRttMs = await pingRttMs(inNs);
  }

  // 量到了不等於驗過了。要求 1000ms 卻量到 3ms,代表 tc 回了 0 但條件沒真的生效 ——
  // 那種情況必須標成「已施加、未確認」,不能因為「有量測」就讓報告寫驗證通過。
  const verified = confirmsLatency({ baselineRttMs, measuredRttMs, latencyMs: applied.latencyMs });

  return {
    applied,
    unsupported,
    ok: true,
    verified,
    ...(typeof baselineRttMs === 'number' ? { baselineRttMs } : {}),
    ...(typeof measuredRttMs === 'number' ? { measuredRttMs } : {}),
    ...(hostIface ? { hostIface } : {}),
  };
}

/**
 * 解除塑形(容器側 + 主機側 veth)。
 * 清不掉不算錯誤:主機在任務結束後就會自我終結,殘留的 qdisc 不影響別的任務。
 */
export async function clearNetem({ container = 'android', run }) {
  const pidRes = await run('docker', ['inspect', '-f', '{{.State.Pid}}', container]);
  const pid = Number(trim(pidRes.stdout));
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false };
  const inNs = (args) => run('nsenter', ['-t', String(pid), '-n', ...args]);
  const iface = await hostVethOf(inNs, run).catch(() => null);
  await inNs(['tc', 'qdisc', 'del', 'dev', 'eth0', 'root']).catch(() => {});
  if (iface) await run('tc', ['qdisc', 'del', 'dev', iface, 'root']).catch(() => {});
  return { ok: true };
}

/**
 * 找出容器 eth0 在主機側的 veth 名稱。
 *
 * 作法:容器內 /sys/class/net/eth0/iflink 是對端在**主機** netns 的 ifindex,
 * 再到主機找同 ifindex 的介面名。這是 veth pair 的標準對應方式。
 */
async function hostVethOf(inNs, run) {
  const link = await inNs(['cat', '/sys/class/net/eth0/iflink']);
  const idx = Number(trim(link.stdout));
  if (!Number.isInteger(idx) || idx <= 0) return null;
  const list = await run('ip', ['-o', 'link']);
  if (list.code !== 0) return null;
  for (const line of String(list.stdout || '').split('\n')) {
    // 形如:「123: vethabc123@if122: <BROADCAST,...>」
    const m = /^(\d+):\s*([^:@\s]+)/.exec(line.trim());
    if (m && Number(m[1]) === idx) return m[2];
  }
  return null;
}

/** 在容器 netns 內量一次到預設閘道的 RTT(毫秒);量不到回 undefined。 */
async function pingRttMs(inNs) {
  try {
    const route = await inNs(['ip', 'route']);
    const gw = /default\s+via\s+(\S+)/.exec(String(route.stdout || ''))?.[1];
    if (!gw) return undefined;
    const res = await inNs(['ping', '-c', '3', '-W', '3', gw]);
    // 取 rtt 統計的平均值:「rtt min/avg/max/mdev = 0.1/0.2/0.3/0.0 ms」
    const avg = /=\s*[\d.]+\/([\d.]+)\//.exec(String(res.stdout || ''))?.[1];
    const n = Number(avg);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  } catch {
    return undefined;
  }
}

const trim = (s) => String(s ?? '').trim();
