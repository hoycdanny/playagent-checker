/**
 * 瀏覽器 console log(相當於 Chrome DevTools 的 Console 分頁)。
 *
 * 為什麼輸出成 logcat 格式
 * ────────────────────────
 * 真機任務的 log 走 devlogs/logcat/<序號>.txt,前端 logcat.ts 的 parseLogcat 解析後由
 * LogcatView 呈現(等級篩選、來源篩選、與任務時間軸連動)。瀏覽器 console 只要吐成同一種
 * 行格式,整套 UI 與 API 分頁機制就能直接重用 —— 不必另造一條管線。
 *
 * 行格式(與 parseLogcat 的 LINE_RE 對齊):
 *   <epoch秒.毫秒>  <pid>  <tid>  <等級>  <來源>: <訊息>
 * pid 借來放「第幾個分頁」(開新視窗時分得出是哪一個);tid 恆為 0。
 * 等級用 logcat 的字母:V/D/I/W/E/F/A。
 *
 * 首行標頭 `# step= at= url= dev= sent=` 供 clockOffset 對時。瀏覽器與 runner 在同一個
 * 容器裡,時鐘相同,所以 dev 與 sent 一致、位移為 0 —— 還是照寫,格式才一致。
 *
 * 量的控制:網頁遊戲可能每一幀都 console.log,不設上限會塞爆 S3 與 API 回應。
 * 這裡做三件事:連續相同訊息合併計數(DevTools 也這樣)、單則截斷、每步上限。
 */

/** console 類型 → logcat 等級字母。 */
const LEVEL_BY_TYPE = {
  error: 'E',
  warning: 'W',
  warn: 'W',
  info: 'I',
  log: 'I',
  debug: 'D',
  trace: 'D',
  dir: 'D',
  table: 'D',
  count: 'D',
  time: 'D',
  timeEnd: 'D',
  assert: 'E',
  profile: 'D',
  startGroup: 'D',
  startGroupCollapsed: 'D',
  endGroup: 'D',
  clear: 'D',
};

/** 單則訊息長度上限(堆疊追蹤很長,但不該無上限)。 */
const MSG_MAX = 2000;
/** 每步最多寫幾行(超過只記「省略 N 行」)。 */
const LINES_PER_STEP = 500;
/** 記憶體裡最多堆幾行(還沒 collect 就先丟最舊的,避免長任務吃光記憶體)。 */
const BUFFER_MAX = 4000;

/** 等級字母;未知類型當 I。 */
export function levelOf(type) {
  return LEVEL_BY_TYPE[String(type || '')] ?? 'I';
}

/**
 * 訊息正規化:壓掉換行(logcat 一行一筆,堆疊追蹤要併成一行)、去掉控制字元、截斷。
 * 回空字串代表這則不值得記。
 */
export function cleanMessage(s) {
  const t = String(s ?? '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' | ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
  return t.length > MSG_MAX ? `${t.slice(0, MSG_MAX)}…(已截斷)` : t;
}

/** 來源標籤不能有冒號(parseLogcat 以第一個冒號切 tag / msg)。 */
export function cleanTag(s) {
  return String(s ?? 'console').replace(/[:\s]+/g, '-').slice(0, 40) || 'console';
}

/** 一行 logcat 格式。at = epoch ms。 */
export function formatLine({ at, level, tag, msg, pageIndex = 1 }) {
  const sec = (Number(at) || Date.now()) / 1000;
  return `${sec.toFixed(3)}  ${Math.max(0, Number(pageIndex) || 0)}  0  ${level}  ${cleanTag(tag)}: ${msg}`;
}

/**
 * 連續相同訊息合併:回新陣列,重複的那筆後面加「(xN)」。
 * 網頁遊戲常每幀印同一行,不合併的話整個面板都是同一句。
 */
export function collapseRepeats(entries) {
  const out = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && prev.level === e.level && prev.tag === e.tag && prev.msg === e.msg && prev.pageIndex === e.pageIndex) {
      prev.count = (prev.count ?? 1) + 1;
      prev.at = e.at; // 以最後一次的時間為準
      continue;
    }
    out.push({ ...e, count: 1 });
  }
  return out;
}

/**
 * @param {object} o
 * @param {(key:string, body:string, contentType:string)=>Promise<unknown>} o.put S3 上傳
 * @param {string} o.prefix  jobs/<id> 前綴
 * @param {(m:string)=>unknown} [o.log]
 * @param {()=>number} [o.now]
 */
export function createBrowserLogs({ put, prefix, log = () => {}, now = () => Date.now() }) {
  /** 尚未上傳的行。 */
  let buf = [];
  /** 因為超過記憶體上限而丟掉的行數。 */
  let dropped = 0;
  let seq = 0;
  /** 累計看到的筆數(供報告呈現「這次測試瀏覽器吐了幾則」)。 */
  const totals = { all: 0, error: 0, warn: 0 };

  return {
    get stats() {
      return { ...totals, pending: buf.length, dropped, chunks: seq };
    },

    /**
     * 收一則瀏覽器事件。由 PlaywrightClient 的 page 事件轉成統一形狀後呼叫。
     * @param {{ type?:string, level?:string, tag?:string, msg:string, at?:number, pageIndex?:number }} e
     */
    push(e) {
      const msg = cleanMessage(e?.msg);
      if (!msg) return;
      const level = e?.level ?? levelOf(e?.type);
      totals.all += 1;
      if (level === 'E' || level === 'F' || level === 'A') totals.error += 1;
      else if (level === 'W') totals.warn += 1;
      if (buf.length >= BUFFER_MAX) {
        buf.shift();
        dropped += 1;
      }
      buf.push({ at: Number(e?.at) || now(), level, tag: cleanTag(e?.tag), msg, pageIndex: e?.pageIndex ?? 1 });
    },

    /**
     * 把目前堆著的行寫成一個片段上傳(沒有東西就不寫,省掉空檔案)。
     * @param {number} step 這是第幾步(寫進標頭供前端對照)
     * @param {string} [url] 目前分頁網址(寫進標頭)
     */
    async collect(step, url = '') {
      if (buf.length === 0) return false;
      const entries = collapseRepeats(buf);
      buf = [];
      const sent = now();
      const head = `# step=${step} at=${new Date(sent).toISOString()} url=${String(url).slice(0, 300)} pid=0 dev=${(sent / 1000).toFixed(3)} sent=${sent}`;
      const kept = entries.slice(0, LINES_PER_STEP);
      const lines = kept.map((e) => formatLine({
        ...e,
        msg: e.count > 1 ? `${e.msg} (x${e.count})` : e.msg,
      }));
      const omitted = entries.length - kept.length;
      if (omitted > 0) lines.push(formatLine({ at: sent, level: 'W', tag: 'runner', msg: `本步 console 訊息過多,已省略 ${omitted} 筆` }));
      if (dropped > 0) {
        lines.push(formatLine({ at: sent, level: 'W', tag: 'runner', msg: `記憶體上限,已丟棄較舊的 ${dropped} 筆` }));
        dropped = 0;
      }
      const name = String(seq).padStart(6, '0');
      seq += 1;
      try {
        await put(`${prefix}/devlogs/console/${name}.txt`, `${head}\n${lines.join('\n')}\n`, 'text/plain; charset=utf-8');
        return true;
      } catch (err) {
        log(`[console] 上傳失敗(略過):${err?.message || err}`);
        return false;
      }
    },
  };
}
