#!/usr/bin/env node
/**
 * emulator 主機自驅動 runner（專業級)—— 在 Redroid 主機上跑,由 emulator-userdata.sh 呼叫。
 * 移植自 game-ai-qa OperatorAgent 的「看→決策→執行→判斷」迴圈,展現遊戲測試方案價值:
 *
 *   每一步:截圖 → 上傳原圖 + 標註圖(紅十字/動作標記) → 雲端 VLM(Claude)看圖判斷下一步
 *   → adb 執行(tap/swipe/type/back) → pHash 偵測畫面變化 → 記錄豐富 step trace
 *   → 直到 VLM 判 done / 達步數上限 / 連續失敗中止。
 *
 * 產出(寫 S3 tenants/<t>/jobs/<jobId>/):
 *   - screenshots/<n>.png       原始截圖
 *   - annotated/<n>.png         標註截圖(紅十字標動作落點)
 *   - steps/<n>.json            逐步 trace(action/coords/reason/duration/screenshot keys)
 *   - report.json               完整報告(steps + 導覽關係圖 nodes/edges + 花費 + 終態)
 *   - status.json               終態(pass/fail/error/cancelled)
 *
 * 決策恆在雲端(Bedrock VLM);主機只負責截圖、標註、執行、記錄。
 * 依賴:主機已裝 adb、aws cli、imagemagick(convert/identify);憑證由實例 profile 提供。
 */
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const JOB = process.env.PLAYAGENT_JOB;
const BUCKET = process.env.PLAYAGENT_BUCKET;
const PREFIX = process.env.PLAYAGENT_PREFIX;
// 'uitars' 是 SageMaker 定位哨兵 id,非 Bedrock 可呼叫模型;emulator 無 UI-TARS 路徑,回退通用 VLM。
const _vlmRaw = process.env.PLAYAGENT_VLM || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const VLM = _vlmRaw === 'uitars' ? 'qwen.qwen3-vl-235b-a22b' : _vlmRaw;
const REGION = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'us-west-2';
const ADB = ['-s', '127.0.0.1:5555'];
const MAX_STEPS = Number(process.env.PLAYAGENT_MAXSTEPS || 30);
const CONSEC_FAIL_LIMIT = 3;

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
const adb = (args) => execFileSync('adb', [...ADB, ...args], { maxBuffer: 64 * 1024 * 1024 });
const adbText = (args) => { try { return adb(args).toString().trim(); } catch { return ''; } };

function s3cp(local, key, ct) {
  execFileSync('aws', ['s3', 'cp', local, `s3://${BUCKET}/${key}`, ...(ct ? ['--content-type', ct] : []), '--region', REGION], { stdio: 'ignore' });
}
function s3put(body, key, ct) {
  writeFileSync('/tmp/_put', body);
  s3cp('/tmp/_put', key, ct);
}

/**
 * 裝置邏輯尺寸(adb input tap 用的座標空間)。
 * wm size 回的是裝置「基準」尺寸,常為直立(如 1080x1920);
 * 應用強制橫屏時,截圖是橫的但 wm size 仍回直立基準 —— 這正是座標錯位的根源。
 */
function deviceSize() {
  const out = adbText(['shell', 'wm', 'size']); // "Physical size: 1080x1920"
  // 優先用 Override size(若有),否則 Physical size。
  const over = /Override size:\s*(\d+)x(\d+)/.exec(out);
  const phys = /Physical size:\s*(\d+)x(\d+)/.exec(out);
  const m = over || phys || /(\d+)x(\d+)/.exec(out);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1080, h: 1920 };
}

/** 目前 surface 旋轉(0=直立,1=CW90,2=180,3=CCW90)—— auto 座標轉換用。 */
function surfaceRotation() {
  // 多來源嘗試,任一命中即用。
  const probes = [
    () => /SurfaceOrientation:\s*(\d)/.exec(adbText(['shell', 'dumpsys', 'input'])),
    () => /mCurrentRotation=ROTATION_(\d+)/.exec(adbText(['shell', 'dumpsys', 'window'])),
    () => /rotation=(\d)/.exec(adbText(['shell', 'dumpsys', 'display'])),
  ];
  for (const p of probes) {
    try {
      const m = p();
      if (m) {
        const v = Number(m[1]);
        // ROTATION_90/180/270 → 1/2/3;SurfaceOrientation 已是 0-3。
        if (v === 90) return 1;
        if (v === 180) return 2;
        if (v === 270) return 3;
        if (v >= 0 && v <= 3) return v;
      }
    } catch {}
  }
  return 0;
}

/** 讀 PNG 實際像素尺寸(ImageMagick identify)。VLM 看的就是這個空間。 */
function imageSize(png) {
  try {
    const out = execFileSync('identify', ['-format', '%wx%h', png], { maxBuffer: 1024 * 1024 }).toString().trim();
    const m = /(\d+)x(\d+)/.exec(out);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  } catch {}
  return null;
}

function screencap(n) {
  adb(['shell', 'screencap', '-p', '/sdcard/s.png']);
  adb(['pull', '/sdcard/s.png', `/tmp/s${n}.png`]);
  s3cp(`/tmp/s${n}.png`, `${PREFIX}/screenshots/${n}.png`, 'image/png');
  return `/tmp/s${n}.png`;
}

/**
 * 截圖像素座標 → 裝置邏輯座標(adb tap 空間)的轉換。
 * 移植自 game-ai-qa coordTransform.transformCoordinates,支援 none/ccw90/cw90/180 + auto 偵測。
 *
 *   ss = 截圖尺寸 {w,h}(VLM 判座標的空間)
 *   dev = 裝置尺寸 {w,h}(adb input tap 的空間)
 *   surfaceRot = 0/1/2/3
 */
const CROSS_MATCH_TOLERANCE = 0.08;
function resolveRotation(ss, dev, surfaceRot) {
  const ssLandscape = ss.w > ss.h, ssPortrait = ss.h > ss.w;
  const devLandscape = dev.w > dev.h, devPortrait = dev.h > dev.w;
  // 方向一致 → 只縮放。
  if ((ssLandscape && devLandscape) || (ssPortrait && devPortrait)) return 'none';
  // 尺寸直接吻合(8% 容差)→ 只縮放。
  if (Math.abs(ss.w - dev.w) / Math.max(dev.w, 1) < CROSS_MATCH_TOLERANCE &&
      Math.abs(ss.h - dev.h) / Math.max(dev.h, 1) < CROSS_MATCH_TOLERANCE) return 'none';
  // 方向不一致 → 依 surfaceRotation 決定旋向。
  if (surfaceRot === 1) return 'cw90';
  if (surfaceRot === 2) return '180';
  if (surfaceRot === 3) return 'ccw90';
  // cross-match(截圖 W≈裝置 H 且截圖 H≈裝置 W)。
  const crossMatch =
    Math.abs(ss.w - dev.h) / Math.max(dev.h, 1) < CROSS_MATCH_TOLERANCE &&
    Math.abs(ss.h - dev.w) / Math.max(dev.w, 1) < CROSS_MATCH_TOLERANCE;
  if (ssLandscape && devPortrait && crossMatch) return 'cw90'; // Android 橫屏最常見 ROTATION_90
  if (ssPortrait && devLandscape && crossMatch) return 'ccw90';
  return 'none';
}
function transformCoordinates(x, y, ss, dev, surfaceRot) {
  const rot = resolveRotation(ss, dev, surfaceRot);
  switch (rot) {
    case 'ccw90':
      return [Math.round(y * dev.w / ss.h), Math.round((ss.w - x) * dev.h / ss.w)];
    case 'cw90':
      return [Math.round((ss.h - y) * dev.w / ss.h), Math.round(x * dev.h / ss.w)];
    case '180':
      return [Math.round((ss.w - x) * dev.w / ss.w), Math.round((ss.h - y) * dev.h / ss.h)];
    case 'none':
    default:
      return [Math.round(x * dev.w / ss.w), Math.round(y * dev.h / ss.h)];
  }
}

/**
 * 在送給 VLM 的截圖上疊一層「座標網格 + 刻度標籤」。
 * VLM 對大圖裡的小按鈕常估不準座標(會指向彈窗中心而非按鈕本身),
 * 疊格線後模型能對齊可見刻度而非在空白處猜,座標精度大幅提升
 * (與 game-ai-qa 的網格輔助標註同思路)。回疊圖路徑;失敗回原圖。
 */
function gridOverlay(srcPng, ss, n) {
  const out = `/tmp/g${n}.png`;
  const stepX = Math.max(1, Math.round(ss.w / 8)); // 每 1/8 寬一條線 → 9 條垂直刻度
  const stepY = Math.max(1, Math.round(ss.h / 8));
  const args = [srcPng, '-stroke', 'rgba(0,200,255,0.5)', '-strokewidth', '2', '-fill', 'none'];
  const labels = [];
  for (let x = stepX; x < ss.w; x += stepX) {
    args.push('-draw', `line ${x},0 ${x},${ss.h}`);
    labels.push({ t: String(x), x: x + 4, y: 34 });        // 頂部 X 刻度
    labels.push({ t: String(x), x: x + 4, y: ss.h - 12 }); // 底部 X 刻度
  }
  for (let y = stepY; y < ss.h; y += stepY) {
    args.push('-draw', `line 0,${y} ${ss.w},${y}`);
    labels.push({ t: String(y), x: 6, y: y - 6 });          // 左側 Y 刻度
    labels.push({ t: String(y), x: ss.w - 90, y: y - 6 });  // 右側 Y 刻度
  }
  // 刻度文字(青色底黑字,確保深淺背景都可讀)。
  args.push('-pointsize', '26', '-stroke', 'none');
  for (const l of labels) {
    args.push('-fill', 'rgba(0,0,0,0.55)', '-draw', `rectangle ${l.x - 2},${l.y - 24} ${l.x + 58},${l.y + 4}`);
    args.push('-fill', 'rgba(0,230,255,0.95)', '-annotate', `+${l.x}+${l.y}`, l.t);
  }
  args.push(out);
  try {
    execFileSync('convert', args, { stdio: 'ignore', maxBuffer: 8 * 1024 * 1024 });
    return out;
  } catch {
    return srcPng;
  }
}

/**
 * 用 ImageMagick 偵測「醒目的遊戲按鈕」中心(如貓咪大戰爭的金色 OK 鈕)。
 * VLM 對大圖裡的小按鈕常估偏(實測誤差 ~330px),而遊戲確認鈕通常是「高彩度、非藍色系、
 * 夠亮」的色塊,和近黑背景反差極大 —— 用純視覺法可精準定位,校正 VLM 座標。
 *
 * 判準(每像素):
 *   - 夠亮:max(r,g,b) > 70
 *   - 高彩度:max−min > 40(排除白/灰的系統彈窗與 UI)
 * 注意:不再排除藍色。許多遊戲主 CTA(如 Golden HoYeah 的 PLAY 鈕)就是亮藍色;
 * 之前用 b≤max(r,g) 排藍會把整顆 PLAY 鈕濾掉,導致吸附失效、VLM 微偏的點擊落在 logo。
 * 系統「Got it」藍色小提示改由「絕對最小尺寸門檻 + 取最大面積塊」自然排除(它很小)。
 * 為省時,先縮到 480 寬跑遮罩 + connected-components,再把質心座標乘回全解析度。
 * 回最大合格色塊質心(截圖像素座標)+ 面積;找不到回 null。經本機對真實截圖驗證命中金色 OK。
 */
function findBrightButton(srcPng, ss) {
  try {
    const DS_W = 480;
    const scale = ss.w / DS_W; // 縮圖→全圖 座標倍率
    const mask = '/tmp/btnmask.png';
    // 縮圖 + 每像素判準(-fx)+ 二值化 + 形態學去雜點/補洞。縮圖後 -fx 很快。
    execFileSync('convert', [
      srcPng, '-resize', `${DS_W}x`,
      '-fx', 'mx=max(max(r,g),b); mn=min(min(r,g),b); (mx*255>70 && (mx-mn)*255>40) ? 1 : 0',
      '-threshold', '50%', '-morphology', 'Close', 'Disk:2', '-morphology', 'Open', 'Disk:1', mask,
    ], { stdio: 'ignore', maxBuffer: 8 * 1024 * 1024 });
    // connected-components:縮圖空間面積門檻 ~80(≈全圖 1280px)。
    const cc = execFileSync('convert', [mask, '-define', 'connected-components:verbose=true',
      '-define', 'connected-components:area-threshold=80', '-connected-components', '8', 'null:'],
      { maxBuffer: 8 * 1024 * 1024 }).toString();
    // 解析 verbose:"  1: 71x31+276+159 310.9,173.8 1815 graya(255,..)" → id: WxH+X+Y cx,cy area color
    const dsW = DS_W, dsH = Math.round(ss.h / scale);
    let best = null;
    for (const line of cc.split('\n')) {
      const m = /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+([\d.]+),([\d.]+)\s+(\d+)\s+(\S+)/.exec(line);
      if (!m) continue;
      const w = +m[1], h = +m[2], cx = +m[5], cy = +m[6], area = +m[7], color = m[8];
      // 只取白色前景塊(遮罩中符合判準者為白);排除黑背景塊。
      // 相容 IM v6/v7 的 verbose 顏色格式:gray(255) / graya(255,..) / srgb(255,255,255) / white。
      const isWhiteFg = /gray(a)?\(255/.test(color) || /white/i.test(color) || /srgba?\(255,255,255/.test(color);
      const isBlackBg = /gray(a)?\(0[,)]/.test(color) || /srgba?\(0,0,0/.test(color) || /black/i.test(color);
      if (!isWhiteFg || isBlackBg) continue;
      if (w >= dsW * 0.9 || h >= dsH * 0.9) continue;      // 排除近全螢幕巨塊
      // 縮圖空間最小尺寸:寬 >= 16(≈全圖 ~64px)排除系統小提示/小圖示雜點;取最大面積塊為主 CTA。
      if (w < 16 || h < 6) continue;
      const ratio = w / h;
      if (ratio < 0.5 || ratio > 10) continue;              // 太細長的線排除
      if (!best || area > best.area) best = { cx, cy, area };
    }
    if (!best) return null;
    return { x: Math.round(best.cx * scale), y: Math.round(best.cy * scale), area: Math.round(best.area * scale * scale) };
  } catch {
    return null;
  }
}

/** ImageMagick 畫紅十字 tap 標記 + 座標標籤(移植 annotateTapPoint 的視覺語彙)。 */
function annotateTap(srcPng, x, y, label, n) {
  const out = `/tmp/a${n}.png`;
  const cross = 80, r = 50;
  try {
    execFileSync('convert', [
      srcPng,
      '-stroke', 'red', '-strokewidth', '5', '-fill', 'none',
      '-draw', `line ${x - cross},${y} ${x + cross},${y}`,
      '-draw', `line ${x},${y - cross} ${x},${y + cross}`,
      '-fill', 'rgba(255,0,0,0.3)', '-stroke', 'red', '-strokewidth', '5',
      '-draw', `circle ${x},${y} ${x},${y - r}`,
      '-fill', 'red', '-stroke', 'none', '-draw', `circle ${x},${y} ${x},${y - 8}`,
      '-fill', 'rgba(255,0,0,0.85)', '-stroke', 'none',
      '-draw', `roundrectangle ${x + r + 10},${y - 26} ${x + r + 230},${y + 26} 6,6`,
      '-fill', 'white', '-pointsize', '28', '-annotate', `+${x + r + 20}+${y + 6}`, `${label} (${x},${y})`,
      out,
    ], { stdio: 'ignore' });
    s3cp(out, `${PREFIX}/annotated/${n}.png`, 'image/png');
    return true;
  } catch {
    return false;
  }
}

/** pHash(用 ImageMagick 縮 8x8 灰階 + 平均)偵測畫面變化。回 0-64 漢明距離。 */
function phash(png) {
  try {
    const raw = execFileSync('convert', [png, '-resize', '16x16!', '-colorspace', 'Gray', '-depth', '8', 'gray:-'], { maxBuffer: 1024 * 1024 });
    return raw; // Buffer 256 bytes
  } catch { return null; }
}
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  const avgA = a.reduce((s, v) => s + v, 0) / a.length;
  const avgB = b.reduce((s, v) => s + v, 0) / b.length;
  let d = 0;
  for (let i = 0; i < a.length; i++) if ((a[i] >= avgA) !== (b[i] >= avgB)) d++;
  return d;
}

function writeStatus(state, message, steps) {
  s3put(JSON.stringify({ jobId: JOB, state, message, steps, updatedAt: new Date().toISOString() }), `${PREFIX}/status.json`, 'application/json');
}

/* ─────────── Memory / 導覽關係圖(移植 game-ai-qa screenHash + memory store)───────────
 * pHash:256x256 灰階 → 32x32=1024 塊均值 → 與全域均值比較成 1024-bit → 256-hex 字串。
 * hamming(256-hex):逐 nibble XOR bit 數。落盤去重閾值 160(對齊原專案 MATCH_THRESHOLD)。
 */
const APP = process.env.PLAYAGENT_APP || 'app';
const MEM_PREFIX = `tenants/${process.env.PLAYAGENT_TENANT}/memory/${APP}`;
// pHash 去重閾值(1024-bit 漢明距離)。100 太寬會把不同畫面全併成一頁;
// 遊戲不同畫面通常差 >150 bit,同畫面 <40 bit。48(~4.7%)可分出不同畫面又容忍動畫抖動。
const MATCH_THRESHOLD = 48;

/** 算 256-hex pHash。 */
function pHashHex(png) {
  try {
    // 32x32 灰階原始位元組(1024 bytes)
    const raw = execFileSync('convert', [png, '-resize', '32x32!', '-colorspace', 'Gray', '-depth', '8', 'gray:-'], { maxBuffer: 1024 * 1024 });
    const bytes = Array.from(raw).slice(0, 1024);
    const avg = bytes.reduce((s, v) => s + v, 0) / bytes.length;
    let bits = '';
    for (const b of bytes) bits += b >= avg ? '1' : '0';
    // 每 4 bit → 1 hex
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex; // 256 hex chars
  } catch { return null; }
}
function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 9999;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}
/** 穩定 pageId:pHash 前段 + 畫面名雜湊,讓「pHash 前段相同但畫面不同」也能分開。 */
function pageIdFromPHash(hex, name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  const suffix = h.toString(16).padStart(4, '0').slice(0, 4);
  return `page_${hex.slice(0, 12)}${suffix}`;
}

/** 讀雲端現有 structure(跨測試累積);不存在回空。 */
function loadStructure() {
  try {
    const s = execFileSync('aws', ['s3', 'cp', `s3://${BUCKET}/${MEM_PREFIX}/structure.json`, '-', '--region', REGION], { maxBuffer: 16 * 1024 * 1024 }).toString();
    return JSON.parse(s);
  } catch {
    return { schemaVersion: 1, appName: APP, rootPageId: null, pages: {}, edges: [], lastUpdatedAt: null };
  }
}
function loadMeta() {
  try {
    const s = execFileSync('aws', ['s3', 'cp', `s3://${BUCKET}/${MEM_PREFIX}/meta.json`, '-', '--region', REGION]).toString();
    return JSON.parse(s);
  } catch { return { totalRuns: 0 }; }
}

/**
 * Memory harvest:把本次 run 的畫面序列(帶 pHash)收斂進累積 structure。
 * frames: [{ phash, pngPath, screen, actionToNext, controls }]
 */
function harvestMemory(frames) {
  if (frames.length === 0) return;
  const struct = loadStructure();
  const meta = loadMeta();
  const now = new Date().toISOString();

  // 既有 page 的 pHash → id 索引(含本 run 新建)。
  const pHashIndex = new Map(Object.values(struct.pages).map((p) => [p.pHash, p.id]));
  const newScreenshots = []; // {pageId, pngPath}

  /** 解析一張畫面 → pageId(精確或 hamming≤160 命中既有;否則新建)。 */
  // 畫面名正規化(去空白/底線,供 dedup 時比對語意)。
  const normName = (s) => String(s || '').replace(/[\s_]+/g, '').toLowerCase();

  const resolvePage = (frame) => {
    if (!frame.phash) return null;
    const fname = normName(frame.screen);
    if (pHashIndex.has(frame.phash)) {
      const id = pHashIndex.get(frame.phash);
      struct.pages[id].visitCount++;
      struct.pages[id].lastSeenAt = now;
      return id;
    }
    // 近似命中:pHash 夠近「且」畫面名相容(相同,或其一為空/通用)才視為同頁。
    // 避免把視覺相近但語意不同的畫面(暗色過場 vs 條款頁)硬併成一頁。
    let best = null, bestDist = MATCH_THRESHOLD + 1;
    for (const p of Object.values(struct.pages)) {
      const d = hammingHex(frame.phash, p.pHash);
      if (d >= bestDist) continue;
      const pname = normName(p.name);
      const nameCompatible = !fname || !pname || fname === pname || fname.includes(pname) || pname.includes(fname);
      if (nameCompatible) { bestDist = d; best = p; }
    }
    if (best && bestDist <= MATCH_THRESHOLD) {
      best.visitCount++; best.lastSeenAt = now;
      // 若既有頁名為通用而本幀有更具體名稱,升級頁名。
      if (fname && (normName(best.name) === '' || /^畫面|^未命名/.test(best.name))) best.name = frame.screen;
      return best.id;
    }
    // 新 page
    const id = pageIdFromPHash(frame.phash, frame.screen);
    if (struct.pages[id]) { struct.pages[id].visitCount++; return id; } // 撞 id(同前段+同名)當同頁
    struct.pages[id] = {
      id, name: frame.screen || '未命名畫面', pHash: frame.phash,
      screenshotRef: `screenshots/${id}.png`,
      knownControlLabels: frame.controls || [],
      visitCount: 1, hitCount: 1, firstSeenAt: now, lastSeenAt: now, lastSeenRunId: JOB,
    };
    pHashIndex.set(frame.phash, id);
    newScreenshots.push({ pageId: id, pngPath: frame.pngPath });
    return id;
  };

  // 逐幀解析 + 建轉移 Edge(相鄰畫面 + 中間動作)。
  let prevId = null, prevAction = null;
  for (const f of frames) {
    const pid = resolvePage(f);
    if (!pid) continue;
    if (struct.rootPageId === null) struct.rootPageId = pid;
    if (prevId && prevId !== pid) {
      const label = prevAction || '';
      let edge = struct.edges.find((e) => e.fromPageId === prevId && e.toPageId === pid && (e.trigger?.label || '') === label);
      if (edge) { edge.hitCount++; edge.lastSeenAt = now; }
      else struct.edges.push({ fromPageId: prevId, toPageId: pid, trigger: { kind: 'tap', label }, hitCount: 1, missCount: 0, firstSeenAt: now, lastSeenAt: now, lastSeenRunId: JOB });
    }
    prevId = pid; prevAction = f.actionToNext;
  }

  struct.lastUpdatedAt = now;
  meta.totalRuns = (meta.totalRuns || 0) + 1;
  meta.totalPages = Object.keys(struct.pages).length;
  meta.totalEdges = struct.edges.length;
  meta.lastHarvestAt = now;

  // 複製新 page 首次截圖到 memory/screenshots/<pageId>.png。
  for (const ns of newScreenshots) {
    try { s3cp(ns.pngPath, `${MEM_PREFIX}/screenshots/${ns.pageId}.png`, 'image/png'); } catch {}
  }
  s3put(JSON.stringify(struct), `${MEM_PREFIX}/structure.json`, 'application/json');
  s3put(JSON.stringify(meta), `${MEM_PREFIX}/meta.json`, 'application/json');
}

/**
 * System prompt(每次執行組一次,放進對話開頭)。ss = 截圖像素尺寸(座標空間)。
 * knowledge = 注入的領域知識(內建類型知識庫 + 使用者知識,可選);有值則附在 prompt 末尾,
 * 讓 agent 依這款遊戲類型的關鍵畫面/術語/測試重點做更懂行的決策。
 * 純函式,供單元測試。
 */
function buildSystemPrompt(ss, knowledge) {
  const base =
    `你是專業遊戲測試工程師,正在測試一個 Android 遊戲。每一步你會看到一張最新截圖(尺寸 ${ss.w}x${ss.h} 像素)。` +
    `圖上疊了青色座標網格:垂直線與水平線每隔 ${Math.round(ss.w / 8)}/${Math.round(ss.h / 8)} 像素一條,線上標了 X/Y 像素刻度。` +
    `你「必須」用這些網格刻度來精確定位:先看目標按鈕落在哪兩條線之間,再內插出精確像素座標。不要憑感覺猜,不要指向彈窗或文字區塊的中心——要精準指到「按鈕本身」的中心。` +
    `座標用「這張截圖」的像素座標(左上角原點 0,0,右下角 ${ss.w},${ss.h})。` +
    `重要:這是一段連續對話,你會記得自己前幾步做了什麼、想了什麼。每步之後我會給你「上一步點擊落點的標註圖(紅十字)+ 執行後的最新畫面」,你要據此判斷上一步是否生效:` +
    `若畫面有推進 → 繼續下一步;若畫面沒變(無效點擊)→ 「不要重複同一個座標」,改點別的按鈕、換座標、或用 back/swipe。` +
    `策略:遊戲開場常有一連串彈窗/公告/教學/權限/下載提示,積極關閉或確認它們以穿透到主畫面。` +
    `區分:「Viewing full screen / Got it」這類是 Android「系統」提示(通常在畫面上緣淺色卡片),點掉不會推進遊戲;` +
    `遊戲「自己」的按鈕(金色/彩色帶邊框的 OK/確定/開始/下載)才會推進——優先點遊戲自己的按鈕。` +
    `目標是進到不同的遊戲畫面(主選單→關卡選擇→戰鬥等),讓測試涵蓋多個畫面。` +
    `先簡短思考(thinking),再給動作。只輸出 JSON:` +
    `{"thinking":"我看到...上一步...我要...","action":"tap|swipe|back|type|wait|done","x":<px>,"y":<px>,"x2":<px>,"y2":<px>,"text":"...","screen":"畫面名稱"}。` +
    `tap 需 x,y;swipe 需 x,y,x2,y2;type 需 text;done 只在真正完成任務或完全無法進行時用。` +
    `screen 用精確的畫面名(如「開場公告彈窗」「主選單」「關卡選擇」「戰鬥中」「商店」「載入中」)描述當前畫面,不同畫面用不同名稱。`;
  // 附上領域知識(內建類型知識庫等):放在末尾當「這款遊戲類型的背景知識」,幫助 agent
  // 認得關鍵畫面與術語、聚焦該類型的測試重點。控長度上限避免 token 爆量。
  const k = typeof knowledge === 'string' ? knowledge.trim() : '';
  if (!k) return base;
  const clipped = k.length > 4000 ? k.slice(0, 4000) : k;
  return (
    base +
    `\n\n以下是這款遊戲「類型」的背景知識(參考用,協助你認得關鍵畫面、術語與測試重點;` +
    `畫面實際內容仍以截圖為準):\n${clipped}`
  );
}

/** 建一個 user turn(可帶多張圖 + 文字)。純函式。 */
function makeUserTurn(images, text) {
  const content = [];
  for (const b64 of images) {
    if (b64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
  }
  content.push({ type: 'text', text });
  return { role: 'user', content };
}

/** 建一個 assistant turn(保留模型自己的推理鏈)。純函式。 */
function makeAssistantTurn(thinking, rawText) {
  return { role: 'assistant', content: [{ type: 'text', text: rawText || JSON.stringify({ thinking }) }] };
}

/**
 * 影像修剪(控 token):只保留「最後 keepLatest 個 user turn」的圖片,較舊的 user turn
 * 把 image 內容拿掉、只留文字。保留完整推理鏈(assistant turns 不動),但不讓歷史截圖累積爆量。
 * 純函式,直接就地修改並回傳同一陣列。移植自參考專案 operatorAgent 的 image-strip 策略。
 */
function pruneImages(messages, keepLatest = 2) {
  const userIdx = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') userIdx.push(i);
  const keepFrom = userIdx.length - keepLatest;
  let seen = 0;
  for (const i of userIdx) {
    const keep = seen >= keepFrom;
    seen++;
    if (keep) continue;
    const msg = messages[i];
    const textParts = (msg.content || []).filter((c) => c.type === 'text');
    // 舊 turn 只留文字;若沒有文字則補一句佔位,避免空 content 被 Bedrock 拒。
    msg.content = textParts.length > 0 ? textParts : [{ type: 'text', text: '(先前畫面)' }];
  }
  return messages;
}

/**
 * 呼叫 Claude VLM 判斷下一步 —— 帶「累積對話 messages」(多輪,含推理鏈),而非每步單輪重建。
 * 送出前先 pruneImages 控 token。回 { cmd, usage, rawText }(rawText 供加入對話歷史)。
 */
function decide(system, messages) {
  pruneImages(messages, 2);
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 500,
    system,
    messages,
  };
  writeFileSync('/tmp/req.json', JSON.stringify(body));
  execFileSync('aws', ['bedrock-runtime', 'invoke-model', '--region', REGION, '--model-id', VLM,
    '--content-type', 'application/json', '--accept', 'application/json',
    '--body', 'fileb:///tmp/req.json', '/tmp/res.json'], { stdio: 'ignore' });
  const parsed = JSON.parse(readFileSync('/tmp/res.json', 'utf8'));
  const out = parsed.content?.find((c) => c.type === 'text')?.text ?? '{}';
  const usage = parsed.usage ? { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens } : null;
  const m = /\{[\s\S]*\}/.exec(out);
  const cmd = m ? JSON.parse(m[0]) : { action: 'done', thinking: '無法解析回應' };
  return { cmd, usage, rawText: out };
}

/**
 * 執行動作。cmd.x/y 是 VLM 給的「截圖像素座標」;tap/swipe 前先轉成裝置座標。
 * ss=截圖尺寸,dev=裝置尺寸,surfaceRot=旋轉。
 */
function act(cmd, ss, dev, surfaceRot) {
  const clamp = (v, max) => Math.max(0, Math.min(Math.round(v), max));
  if (cmd.action === 'tap') {
    const [dx, dy] = transformCoordinates(cmd.x, cmd.y, ss, dev, surfaceRot);
    adb(['shell', 'input', 'tap', String(clamp(dx, dev.w)), String(clamp(dy, dev.h))]);
  } else if (cmd.action === 'swipe') {
    const [dx, dy] = transformCoordinates(cmd.x, cmd.y, ss, dev, surfaceRot);
    const [dx2, dy2] = transformCoordinates(cmd.x2 ?? cmd.x, cmd.y2 ?? cmd.y, ss, dev, surfaceRot);
    adb(['shell', 'input', 'swipe', String(clamp(dx, dev.w)), String(clamp(dy, dev.h)), String(clamp(dx2, dev.w)), String(clamp(dy2, dev.h)), '300']);
  } else if (cmd.action === 'back') adb(['shell', 'input', 'keyevent', '4']);
  else if (cmd.action === 'type') adb(['shell', 'input', 'text', String(cmd.text || '').replace(/[^\w ]/g, '')]);
  else if (cmd.action === 'wait') sh('sleep 2');
}

function main() {
  // 讀 job.json 取任務描述。
  let task = '啟動遊戲,通過開場動畫與任何彈窗,進入遊戲主畫面,並嘗試開始一場遊戲';
  try {
    const job = JSON.parse(execFileSync('aws', ['s3', 'cp', `s3://${BUCKET}/${PREFIX}/job.json`, '-', '--region', REGION]).toString());
    if (job.caseTask) task = job.caseTask;
  } catch {}

  // 讀 context.json 取「注入的領域知識」(engine 依 App genre + 選定知識庫組出,含內建類型知識庫)。
  // 有則加進 system prompt,讓 agent 依這款遊戲類型的關鍵畫面/術語/測試重點做決策。讀不到不影響執行。
  let knowledge = '';
  try {
    const ctx = JSON.parse(execFileSync('aws', ['s3', 'cp', `s3://${BUCKET}/${PREFIX}/context.json`, '-', '--region', REGION], { maxBuffer: 8 * 1024 * 1024 }).toString());
    if (ctx && typeof ctx.context === 'string') knowledge = ctx.context;
  } catch {}

  // 注意:adb `input tap` 與 `screencap` 共用「當前旋轉」的同一座標空間;
  // `wm size` 回的是「未旋轉基準」尺寸(如直立 1080x1920),不等於 tap 空間。
  // 經主機實測確認:app 橫屏執行時 screencap=1920x1080、tap 也吃 1920x1080,
  // 兩者恆一致。故 tap 空間 = 截圖尺寸,座標轉換退化為 identity。
  // deviceSize() 只留作 fallback(截圖尺寸讀不到時)。
  const devFallback = deviceSize();
  // 若已知遊戲包名,先確保遊戲在前景(防它在啟動與 runner 之間落到背景)。
  const pkg = process.env.PLAYAGENT_PKG;
  if (pkg && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(pkg)) {
    try {
      const act = adbText(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', '-a', 'android.intent.action.MAIN', pkg]).split('\n').pop().trim();
      if (act.includes('/')) adb(['shell', 'am', 'start', '-n', act]);
      else adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
      sh('sleep 8');
    } catch {}
  }
  writeStatus('running', 'AI 測試代理執行中', 0);

  const steps = [];
  const nodes = []; // 導覽關係圖節點(畫面)
  const edges = []; // 節點間轉移(動作)
  const frames = []; // memory harvest 用:每步畫面 pHash + screen + 動作
  let lastNodeId = null;
  let lastPhash = null;
  let stuckCount = 0;
  let consecFail = 0;
  let lastScreenSize = devFallback; // 供報告記錄畫面尺寸
  let finalState = 'fail';
  let finalMsg = '達步數上限仍未完成';
  const tokamt = { input: 0, output: 0 };

  // 累積對話(參考專案 operatorAgent 模式):system 只組一次;每步 append user turn(截圖+回饋)
  // 與 assistant turn(推理+動作),讓模型記得自己前幾步的推理,不再繞圈。system prompt 依首張截圖
  // 尺寸組;之後尺寸不變(同一裝置)。
  let system = null;
  const messages = [];
  // 追蹤上一步的標註圖(紅十字落點)與動作描述,供下一步回饋「你上一步點這、生效了嗎」。
  let lastAnnotatedB64 = null;
  let lastActionDesc = null;

  for (let i = 0; i < MAX_STEPS; i++) {
    // 取消檢查
    try { execFileSync('aws', ['s3', 'ls', `s3://${BUCKET}/${PREFIX}/cancel.json`, '--region', REGION], { stdio: 'ignore' }); finalState = 'cancelled'; finalMsg = '使用者取消'; break; } catch {}

    const t0 = Date.now();
    const png = screencap(i);
    // 截圖實際像素尺寸(VLM 座標空間)。adb tap 與 screencap 同空間,故 tap 空間 = 截圖尺寸。
    const ss = imageSize(png) || devFallback;
    const dev = ss; // tap 座標空間 == 截圖座標空間(實測確認)
    lastScreenSize = ss;
    const surfaceRot = surfaceRotation();

    // 本步畫面 pHash,與上一步比較 → 是否卡在同一畫面。
    const curPh = phash(png);
    const changedFromPrev = lastPhash && curPh ? hamming(lastPhash, curPh) > 12 : true;
    if (lastPhash && !changedFromPrev) stuckCount++; else stuckCount = 0;
    lastPhash = curPh;

    // 疊座標網格給 VLM 對齊刻度(提升座標精度)。
    const gridPng = gridOverlay(png, ss, i);
    const gridB64 = readFileSync(gridPng).toString('base64');

    // system 只組一次(首張截圖尺寸為準)。附上注入的領域知識(內建類型知識庫等)。
    if (system === null) system = buildSystemPrompt(ss, knowledge);

    // 組本步的 user turn 並加入對話:
    //  - 第 0 步:任務目標 + 當前(疊格線)截圖。
    //  - 之後:回饋「上一步做了什麼、畫面有沒有變」+ 上一步標註圖(紅十字)+ 當前截圖,讓模型自我修正。
    if (messages.length === 0) {
      messages.push(makeUserTurn([gridB64], `任務目標:${task}\n這是目前畫面,請判斷並決定下一步。`));
    } else {
      const changedNote = changedFromPrev
        ? '畫面已改變(上一步可能生效)'
        : (stuckCount >= 2
            ? `畫面連續 ${stuckCount + 1} 步沒有改變。你的點擊有送到裝置但沒作用,表示你瞄的位置不是可互動的按鈕。` +
              '請重新在畫面上找「主要行動按鈕」(通常是最大、最醒目、置中或中下方的按鈕,文字如 PLAY / START / 開始 / 確定 / GO),' +
              '把座標對準那顆按鈕的正中心,而不是 logo、角色或裝飾。換一個明顯不同的位置,不要再點同一個地方。'
            : '畫面沒有改變(上一步可能無效,換個做法、不要重複同座標)');
      const fb = `上一步你執行了:${lastActionDesc || '(未知)'}。${changedNote}。` +
        (lastAnnotatedB64 ? '第一張是上一步點擊落點的標註圖(紅十字),第二張是執行後的最新畫面。' : '以下是最新畫面。') +
        '請判斷上一步是否生效並決定下一步。';
      const imgs = lastAnnotatedB64 ? [lastAnnotatedB64, gridB64] : [gridB64];
      messages.push(makeUserTurn(imgs, fb));
    }

    // 決策(帶累積對話 + 推理鏈)。
    let cmd, usage;
    try {
      const r = decide(system, messages);
      cmd = r.cmd; usage = r.usage;
      // 保留模型自己的回應到對話(推理鏈),下一步才「記得」自己想過什麼。
      messages.push(makeAssistantTurn(cmd.thinking, r.rawText));
      if (usage) { tokamt.input += usage.input; tokamt.output += usage.output; }
    } catch (e) {
      steps.push({ stepNumber: i, action: 'error', reason: `VLM 判斷失敗: ${e}`, screenshotKey: `${PREFIX}/screenshots/${i}.png`, durationMs: Date.now() - t0 });
      consecFail++;
      if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = 'VLM 連續失敗'; break; }
      continue;
    }
    // 重置本步標註圖;若本步是 tap/swipe 會在下方標註後填入,供下一步回饋。
    lastAnnotatedB64 = null;
    lastActionDesc = `${cmd.action}${cmd.x != null ? `(${Math.round(cmd.x)},${Math.round(cmd.y)})` : ''}`;

    // 卡住脫困:連續 ≥3 步畫面沒變才介入(先尊重 VLM 判斷,避免打斷過場動畫)。
    // 4 段輪換,關鍵是把「畫面中央主按鈕(PLAY/START/開始)」與「交還 VLM 自己重新瞄準」納入,
    // 不再只點死角(先前 bug:splash 上主 CTA 在中央,狂點右上角永遠脫不了困)。
    //   mode0: back
    //   mode1: 點畫面正中央偏下(主 CTA 常在此,如 Golden HoYeah 的 PLAY 鈕)
    //   mode2: 交還 VLM 自己選的動作(讓它換位置重瞄,配合下方 findBrightButton 吸附到藍鈕)
    //   mode3: 點右上角(關閉鈕常在此)
    let escapeOverride = false;
    if (stuckCount >= 3) {
      const mode = (stuckCount - 3) % 4;
      if (mode === 0) {
        cmd = { action: 'back', thinking: `連續 ${stuckCount} 步畫面沒變,用 back 脫困`, screen: cmd.screen };
        escapeOverride = true;
      } else if (mode === 1) {
        cmd = { action: 'tap', x: Math.round(ss.w * 0.50), y: Math.round(ss.h * 0.64), thinking: `連續 ${stuckCount} 步畫面沒變,點畫面中央偏下(主按鈕 PLAY/START/開始 常在此)脫困`, screen: cmd.screen };
        escapeOverride = true;
      } else if (mode === 2) {
        // 交還 VLM 自己的選擇(不覆寫 cmd),但仍允許下方亮鈕吸附修正微偏。
      } else {
        cmd = { action: 'tap', x: Math.round(ss.w * 0.93), y: Math.round(ss.h * 0.08), thinking: `連續 ${stuckCount} 步畫面沒變,點右上角(關閉鈕常在此)脫困`, screen: cmd.screen };
        escapeOverride = true;
      }
    }

    // 座標校正:VLM 對小按鈕常估偏。若偵測到明亮遊戲按鈕且離 VLM 猜測不遠,吸附到按鈕中心。
    // (tap 且非硬脫困覆寫時做;mode2 交還 VLM 也吸附,好把微偏的點擊拉到藍色 PLAY 鈕中心。
    //  吸附距離 420px 涵蓋實測誤差 ~330px,又不致亂跳到無關按鈕。)
    let snappedFrom = null;
    if (cmd.action === 'tap' && cmd.x != null && !escapeOverride) {
      const btn = findBrightButton(png, ss);
      if (btn) {
        const dist = Math.hypot(btn.x - cmd.x, btn.y - cmd.y);
        if (dist > 24 && dist <= 420) {
          snappedFrom = { x: Math.round(cmd.x), y: Math.round(cmd.y), dist: Math.round(dist), btnArea: btn.area };
          cmd.x = btn.x; cmd.y = btn.y;
        }
      }
    }

    // 標註(tap/swipe 才畫落點)
    let annotated = false;
    if (cmd.action === 'tap' && cmd.x != null) annotated = annotateTap(png, Math.round(cmd.x), Math.round(cmd.y), 'TAP', i);
    else if (cmd.action === 'swipe' && cmd.x != null) annotated = annotateTap(png, Math.round(cmd.x), Math.round(cmd.y), 'SWIPE', i);
    // 擷取標註圖 b64,供下一步回饋「你上一步點在這、生效了嗎」。
    if (annotated) {
      try { lastAnnotatedB64 = readFileSync(`/tmp/a${i}.png`).toString('base64'); } catch { lastAnnotatedB64 = null; }
    }

    // 導覽關係圖:當前畫面為節點,動作為邊。
    const screenName = cmd.screen || `畫面 ${i}`;
    const nodeId = `n${i}`;
    nodes.push({ id: nodeId, step: i, screen: screenName, screenshotKey: `${PREFIX}/screenshots/${i}.png` });
    if (lastNodeId) edges.push({ from: lastNodeId, to: nodeId, action: steps.at(-1)?.action || '' });
    lastNodeId = nodeId;

    // 轉換後的裝置座標(供 trace 除錯:VLM 說的截圖座標 vs 實際 tap 的裝置座標)。
    let deviceCoords = null;
    if (cmd.x != null && (cmd.action === 'tap' || cmd.action === 'swipe')) {
      const [tx, ty] = transformCoordinates(cmd.x, cmd.y, ss, dev, surfaceRot);
      deviceCoords = { x: tx, y: ty };
    }

    const step = {
      stepNumber: i,
      action: cmd.action,
      screen: screenName,
      reason: cmd.thinking || '',
      ...(cmd.x != null ? { coords: { x: Math.round(cmd.x), y: Math.round(cmd.y) } } : {}),
      ...(snappedFrom ? { snappedFrom } : {}),
      ...(deviceCoords ? { deviceCoords } : {}),
      screenshotSize: ss,
      deviceSize: dev,
      // 與上一步比較:本畫面是否已改變(false = 卡住)。第 0 步無前一畫面可比。
      ...(i > 0 ? { screenChanged: changedFromPrev } : {}),
      ...(surfaceRot ? { surfaceRotation: surfaceRot } : {}),
      ...(cmd.text ? { text: cmd.text } : {}),
      screenshotKey: `${PREFIX}/screenshots/${i}.png`,
      ...(annotated ? { annotatedKey: `${PREFIX}/annotated/${i}.png` } : {}),
      durationMs: Date.now() - t0,
      ...(usage ? { tokens: usage } : {}),
      decidedInCloud: true,
    };
    steps.push(step);
    s3put(JSON.stringify({ index: i, ...step }), `${PREFIX}/steps/${i}.json`, 'application/json');
    writeStatus('running', `第 ${i + 1} 步:${cmd.action} @ ${screenName}`, steps.length);

    // memory harvest 收集:本步畫面 pHash + screen 名 + 這步動作(作為到下一畫面的 trigger label)。
    frames.push({ phash: pHashHex(png), pngPath: png, screen: screenName, actionToNext: cmd.action });

    if (cmd.action === 'done') { finalState = 'pass'; finalMsg = cmd.thinking || '流程完成'; break; }

    // 執行(VLM 座標→裝置座標轉換在 act 內完成)
    try { act(cmd, ss, dev, surfaceRot); consecFail = 0; } catch (e) {
      consecFail++;
      step.execError = String(e);
      if (consecFail >= CONSEC_FAIL_LIMIT) { finalState = 'error'; finalMsg = '連續動作失敗'; break; }
    }
    sh('sleep 3'); // 等畫面穩定(下一輪 screencap 後會與本步 pHash 比較是否改變)
  }

  // 產出完整報告(含關係圖)。
  const report = {
    jobId: JOB,
    state: finalState,
    message: finalMsg,
    task,
    device: lastScreenSize,
    vlmModel: VLM,
    stepCount: steps.length,
    steps,
    navGraph: { nodes, edges },
    tokens: tokamt,
    generatedAt: new Date().toISOString(),
  };
  s3put(JSON.stringify(report), `${PREFIX}/report.json`, 'application/json');

  // Memory harvest:把本次畫面序列收斂進跨測試累積的 App 導覽地圖(pHash 去重建 Page/Edge)。
  try { harvestMemory(frames); } catch (e) { /* harvest 失敗不影響任務終態 */ }

  writeStatus(finalState, finalMsg, steps.length);
}

// 純函式匯出(供單元測試座標轉換與對話組裝邏輯,不觸發主流程)。
export {
  transformCoordinates,
  resolveRotation,
  buildSystemPrompt,
  makeUserTurn,
  makeAssistantTurn,
  pruneImages,
};

// 僅在被直接執行(node emulatorRunner.mjs)時跑主流程;被 import 時不跑。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) { writeStatus('error', String(e), 0); process.exit(1); }
}
