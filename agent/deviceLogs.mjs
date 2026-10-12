/**
 * 真機 log 收集(Device Farm Appium `mobile: shell`,等同 adb shell)。每一步收一次,存到 S3 供任務詳情頁查看。
 *
 *   ${prefix}/devlogs/logcat/<序號6位>.txt   這段時間的 logcat:被測 App 全部 + 全系統 W/E 級 + crash buffer
 *   ${prefix}/devlogs/audio/<序號6位>.json   dumpsys audio「播放器」狀態 + audio_flinger 聲音輸出狀態
 *
 * logcat 用裝置時間 `-T <上次的裝置時間>` 只取新的行(裝置時鐘與 runner 不同,以裝置 `date` 為準)。
 * 每段有行數上限,避免系統 log 洗版把 S3 / API 撐爆。全部盡力而為:失敗就略過這一輪。
 */

const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const APP_LINES = 1500;
const SYS_LINES = 400;

/** 依「@@KEY」行切段(同 perfMonitor 的格式)。 */
export function splitSections(out) {
  const map = {};
  let key = null;
  for (const line of String(out || '').split('\n')) {
    const m = /^@@(\w+)\s*(.*)$/.exec(line);
    if (m) { key = m[1]; map[key] = m[2] ? `${m[2]}\n` : ''; continue; }
    if (key) map[key] += `${line}\n`;
  }
  return map;
}

/**
 * dumpsys audio 的 playback activity → 播放器清單。
 * 例:`AudioPlaybackConfiguration piid:15 deviceIds:[2] u/pid:10234/12345 type:android.media.AudioTrack
 *      attr:AudioAttributes: usage=USAGE_GAME content=CONTENT_TYPE_UNKNOWN ... state:started`
 */
export function parsePlayers(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    // 兩種格式:`AudioPlaybackConfiguration piid:15 ...`,或 PlayerBase 段的 `ID:15 -- type:... -- state:started`。
    const piid = /AudioPlaybackConfiguration\b.*?piid:(\d+)/.exec(line)?.[1] ?? /^\s*ID:(\d+)\s+--\s+type:/.exec(line)?.[1];
    if (!piid || seen.has(piid)) continue;
    seen.add(piid);
    const pid = /u\/pid:\d+\/(\d+)/.exec(line)?.[1];
    const usage = /usage=(\w+)/.exec(line)?.[1];
    const content = /content=(\w+)/.exec(line)?.[1];
    const state = /state:(\w+)/.exec(line)?.[1];
    const type = /type:([\w.]+)/.exec(line)?.[1];
    out.push({
      piid: Number(piid),
      ...(pid ? { pid: Number(pid) } : {}),
      ...(usage ? { usage: usage.replace(/^USAGE_/, '') } : {}),
      ...(content ? { content: content.replace(/^CONTENT_TYPE_/, '') } : {}),
      ...(type ? { type: type.replace(/^android\.media\./, '') } : {}),
      ...(state ? { state } : {}),
    });
  }
  return out;
}

/** audio_flinger 輸出執行緒摘要:是否待機、聲音軌數(含 active 數)。 */
export function parseFlinger(text) {
  const outputs = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const th = /Output thread (0x[0-9a-f]+)/i.exec(line);
    if (th) { cur = { thread: th[1] }; outputs.push(cur); continue; }
    if (!cur) continue;
    const sb = /Standby:\s*(yes|no)/i.exec(line);
    if (sb) cur.standby = sb[1].toLowerCase() === 'yes';
    const tr = /(\d+)\s+Tracks? of which (\d+) (?:are|is) active/i.exec(line);
    if (tr) { cur.tracks = Number(tr[1]); cur.active = Number(tr[2]); }
  }
  return outputs;
}

export function createDeviceLogs({ client, put, prefix, pkg, log = () => {} }) {
  const safePkg = PKG_RE.test(pkg || '') ? pkg : '';
  let since = null; // 上一輪的裝置時間(epoch 秒字串)
  let seq = 0;
  let busy = false;
  let failures = 0;

  async function collect(step) {
    if (busy || failures >= 5) return null;
    busy = true;
    try {
      const range = since ? `-T ${since}` : '-t 300';
      const pidCmd = safePkg ? `P=$(pidof -s ${safePkg})` : 'P=';
      const cmd = [
        pidCmd,
        'echo @@NOW; date +%s.%N | cut -c1-14',
        `echo @@PID; echo $P`,
        `echo @@APP; [ -n "$P" ] && logcat -d -v epoch ${range} --pid=$P 2>/dev/null | tail -n ${APP_LINES}`,
        `echo @@SYS; logcat -d -v epoch ${range} -b main,system,crash '*:W' 2>/dev/null | tail -n ${SYS_LINES}`,
        "echo @@AUDIO; dumpsys audio 2>/dev/null | grep -iE 'AudioPlaybackConfiguration|^ *ID:[0-9]+ -- type:|playback activity' | head -n 120",
        "echo @@FLINGER; dumpsys media.audio_flinger 2>/dev/null | grep -iE 'Output thread|Standby:|Tracks? of which|Last write' | head -n 80",
        'true',
      ].join('; ');
      const sentAt = Date.now();
      const s = splitSections(String(await client.shell(cmd, 20000)));
      const now = (s.NOW ?? '').trim();
      const at = Date.now();
      const name = String(seq++).padStart(6, '0');
      // App 與系統 log 合併(同一行可能同時出現在兩邊:App 的 W/E 也是系統 W/E),依時間排序去重。
      const lines = [...new Set([...(s.APP ?? '').split('\n'), ...(s.SYS ?? '').split('\n')])]
        .filter((l) => /^\s*\d{9,}\.\d+/.test(l))
        .sort((a, b) => Number(a.trim().split(/\s+/)[0]) - Number(b.trim().split(/\s+/)[0]));
      const pid = Number((s.PID ?? '').trim()) || undefined;
      // dev/sent:同一時刻的裝置時間與 runner 時間 → 前端把 log 時間對到錄影 / 步驟的時間軸(裝置時鐘常差幾秒)。
      // NOW 是 shell 指令裡第一個執行的,≈ 送出後單程延遲(約 0.1–0.3 秒),用送出時間對時。
      const clock = /^\d{9,}\.\d+$/.test(now) ? ` dev=${now} sent=${sentAt}` : '';
      if (lines.length) await put(`${prefix}/devlogs/logcat/${name}.txt`, `# step=${step} at=${at}${pid ? ` pid=${pid}` : ''}${clock}\n${lines.join('\n')}\n`, 'text/plain; charset=utf-8');
      const audio = {
        step,
        at,
        ...(pid ? { pid } : {}),
        players: parsePlayers(s.AUDIO),
        outputs: parseFlinger(s.FLINGER),
        playbackRaw: (s.AUDIO ?? '').slice(0, 20_000),
        flingerRaw: (s.FLINGER ?? '').slice(0, 10_000),
      };
      await put(`${prefix}/devlogs/audio/${name}.json`, JSON.stringify(audio), 'application/json');
      if (/^\d{9,}\.\d+$/.test(now)) since = now;
      failures = 0;
      return { lines: lines.length, players: audio.players.length };
    } catch (e) {
      failures++;
      log(`[devlogs] 收集失敗(${failures}):${String(e?.message || e).slice(0, 160)}`);
      return null;
    } finally {
      busy = false;
    }
  }

  return { collect };
}
