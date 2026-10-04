/**
 * 影像輔助工具(Device Farm runner 用,依賴容器內的 ImageMagick `convert`/`identify`)。
 *
 * 移植自 infra/lambda/engine/emulatorRunner.mjs 的座標校正三件套,提升 VLM 在真機截圖上的
 * 點擊精度(VLM 對大圖裡的按鈕常估偏,尤其 Cocos2d-x/Unity 這類整張畫布無原生元素的遊戲):
 *   1. gridOverlay      —— 疊座標網格 + 刻度標籤,讓 VLM 對齊可見刻度而非在空白猜。
 *   2. findBrightButton —— 純視覺偵測畫面最醒目的按鈕(高亮高彩度色塊),用來吸附 VLM 微偏的點擊。
 *   3. annotateTap      —— 在點擊座標畫紅十字 + 圓圈 + 座標標籤,產出「AI 點在哪」的可視化圖。
 *
 * 全部走本地暫存檔 + execFileSync,失敗都優雅回退(不擋主流程)。
 */
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// IM6 的 -annotate 需要明確字型檔,否則(容器內 fontconfig 未對映)會 Abort。
// 容器已裝 fonts-dejavu-core;找出可用的 .ttf 供 -font 指定。
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];
const FONT_PATH = FONT_CANDIDATES.find((p) => existsSync(p)) || null;
/** 有字型才回 ['-font', path];否則空陣列(呼叫端據此略過文字標籤)。 */
function fontArgs() {
  return FONT_PATH ? ['-font', FONT_PATH] : [];
}

/**
 * 即時畫面幀壓縮:真機 PNG(1080×2400 約 2-3MB)→ 長邊 ≤ maxEdge 的 JPEG(約 50-100KB)。
 * 非同步(stdin/stdout 管線),不阻塞 AI 主迴圈;失敗/逾時回 null(呼叫端改傳原 PNG)。
 */
export function liveJpeg(pngBuf, maxEdge = 720, quality = 60, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try {
      p = spawn('convert', ['png:-', '-resize', `${maxEdge}x${maxEdge}>`, '-quality', String(quality), 'jpg:-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { finish(null); return; }
    const chunks = [];
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } finish(null); }, timeoutMs);
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', () => { clearTimeout(timer); finish(null); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      finish(code === 0 && out.length > 0 ? out : null);
    });
    p.stdin.on('error', () => { /* EPIPE:convert 提早結束,交給 close 處理 */ });
    p.stdin.end(pngBuf);
  });
}

/** 把 base64 PNG 落成暫存檔,回路徑。 */
export function b64ToTmp(b64, tag) {
  const p = join(tmpdir(), `pa-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

/** 檔案 → base64。 */
export function fileToB64(p) {
  return readFileSync(p).toString('base64');
}

/**
 * 縮圖給 VLM 用:把整張截圖(PNG base64)長邊縮到 maxEdge、轉 JPEG(壓縮體積),
 * 讓請求 body 不超過模型端點上限(如 Qwen converse 對大圖會回「body 太大」)。
 *
 * 座標一致性(關鍵):回傳「縮圖後的實際寬高 w/h」,呼叫端必須用這組尺寸當座標空間
 * (告訴模型的尺寸、setCoordinateSpace、網格/吸附/標記),模型回的座標才會落在縮圖空間,
 * client 再換算成裝置視窗座標——全鏈路一致,點擊不會偏。
 *
 * 回 { b64, w, h, bytes, format } —— format 為 'jpeg' 或(失敗回退)'png'。
 * ImageMagick 不可用或縮圖失敗時,回退為原圖 PNG(w/h 用傳入的 origW/origH)。
 */
/**
 * Qwen2.5/3-VL 系(含 UI-TARS)的 smart_resize:算出模型實際「看到的」圖尺寸。
 * 模型會把輸入圖對齊到「兩邊都能被 28 整除、總畫素落在 [MIN,MAX] 內、盡量維持寬高比」,
 * 並在那張縮放後的圖的座標系裡回報「絕對像素座標」。所以我們必須:
 *   1. 先把截圖縮到這個尺寸再送(送出尺寸 == 模型座標基準),
 *   2. 模型回的像素座標,除以 resizedW/H 得比例,再乘裝置原尺寸 → 正確落點。
 * 移植自 game-ai-qa/src/utils/smartResize.ts(對齊 OSWorld 官方 max_pixels)。
 * 回 [hBar, wBar]。
 */
const SR_FACTOR = 28;
const SR_MIN_PIXELS = 3136;
// OSWorld 官方基準:>2.1M 畫素時 7B grounding 嚴重退化(誤差 ~200px);縮到 2.1M 誤差 ~40px。
const SR_MAX_PIXELS = 2_116_800;
export function smartResizeDims(h, w) {
  let hBar = Math.max(SR_FACTOR, Math.round(h / SR_FACTOR) * SR_FACTOR);
  let wBar = Math.max(SR_FACTOR, Math.round(w / SR_FACTOR) * SR_FACTOR);
  if (hBar * wBar > SR_MAX_PIXELS) {
    const beta = Math.sqrt((h * w) / SR_MAX_PIXELS);
    hBar = Math.floor(h / beta / SR_FACTOR) * SR_FACTOR;
    wBar = Math.floor(w / beta / SR_FACTOR) * SR_FACTOR;
  } else if (hBar * wBar < SR_MIN_PIXELS) {
    const beta = Math.sqrt(SR_MIN_PIXELS / (h * w));
    hBar = Math.ceil((h * beta) / SR_FACTOR) * SR_FACTOR;
    wBar = Math.ceil((w * beta) / SR_FACTOR) * SR_FACTOR;
  }
  return [hBar, wBar];
}

/**
 * 把截圖(PNG base64)強制縮放到 smart_resize 尺寸並轉 JPEG,回 { b64, w, h, bytes, format }。
 * w/h 為 smart-resize 後的尺寸(即模型座標基準)。ImageMagick 不可用/失敗時回退原圖 PNG。
 *
 * 與 downscaleForVlmB64 的差別:這裡輸出「精確等於 smartResizeDims 的尺寸」(用 `WxH!` 強制),
 * 讓「送出圖的像素空間」與「模型回報座標的空間」完全一致——這是座標準確的關鍵。
 */
export function resizeToSmartB64(srcPngB64, origW, origH, quality = 82) {
  const [rh, rw] = smartResizeDims(origH || 1, origW || 1);
  let src;
  try {
    src = b64ToTmp(srcPngB64, 'sr-src');
    const out = join(tmpdir(), `pa-sr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
    // `!` 強制精確尺寸(不保比例湊整);smart_resize 已維持了比例,這裡只是精確落到那個尺寸。
    execFileSync('convert', [src, '-resize', `${rw}x${rh}!`, '-quality', String(quality), out],
      { maxBuffer: 64 * 1024 * 1024 });
    const buf = readFileSync(out);
    return { b64: buf.toString('base64'), w: rw, h: rh, bytes: buf.length, format: 'jpeg' };
  } catch {
    const bytes = Math.floor((srcPngB64.length * 3) / 4);
    return { b64: srcPngB64, w: origW, h: origH, bytes, format: 'png' };
  }
}

export function downscaleForVlmB64(srcPngB64, origW, origH, maxEdge = 1280, quality = 82) {
  const longEdge = Math.max(origW || 0, origH || 0);
  // 座標一致性關鍵:縮圖尺寸「用數學算」,不靠 identify(容器內 identify 若失敗會回原尺寸,
  // 造成 ds.b64 像素與回傳 w/h 不符 → annotate/denorm 在錯誤尺寸空間運作 → 點擊歪掉)。
  // 等比縮放:scale = min(1, maxEdge/longEdge);cw/ch 由 origW/origH × scale 直接算出(四捨五入)。
  const scale = longEdge > maxEdge && longEdge > 0 ? maxEdge / longEdge : 1;
  const cw = Math.max(1, Math.round((origW || 0) * scale));
  const ch = Math.max(1, Math.round((origH || 0) * scale));
  let src;
  try {
    src = b64ToTmp(srcPngB64, 'vlm-src');
    const out = join(tmpdir(), `pa-vlm-ds-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
    // 明確指定輸出尺寸 `${cw}x${ch}!`(驚嘆號=強制精確尺寸),讓 ds.b64 的實際像素「保證」等於 cw/ch,
    // 全鏈路(模型看到的圖/網格/吸附/落點標記/denorm)都用同一組尺寸,不會有比例誤差。
    // scale=1(不需縮)時就不加 -resize,只轉 JPEG 壓體積。
    const args = [src];
    if (scale < 1) args.push('-resize', `${cw}x${ch}!`);
    args.push('-quality', String(quality), out);
    execFileSync('convert', args, { maxBuffer: 64 * 1024 * 1024 });
    const buf = readFileSync(out);
    return { b64: buf.toString('base64'), w: cw, h: ch, bytes: buf.length, format: 'jpeg' };
  } catch {
    // 縮圖失敗:回退原圖 PNG(座標空間為原尺寸,ds.b64 像素 == origW/origH,仍一致)。
    const bytes = Math.floor((srcPngB64.length * 3) / 4);
    return { b64: srcPngB64, w: origW, h: origH, bytes, format: 'png' };
  }
}

/**
 * 感知雜湊(pHash):32x32 灰階 → 與均值比較成 1024-bit → 256-hex。用來偵測「畫面有沒有變」。
 * 回 hex 字串或 null。
 */
export function pHashHex(srcB64) {
  let src;
  try {
    src = b64ToTmp(srcB64, 'ph-src');
    const raw = execFileSync('convert', [src, '-resize', '32x32!', '-colorspace', 'Gray', '-depth', '8', 'gray:-'],
      { maxBuffer: 4 * 1024 * 1024 });
    const bytes = Array.from(raw).slice(0, 1024);
    if (bytes.length < 1024) return null;
    const avg = bytes.reduce((s, v) => s + v, 0) / bytes.length;
    let hex = '';
    for (let i = 0; i < 1024; i += 4) {
      let nib = 0;
      for (let b = 0; b < 4; b++) if (bytes[i + b] >= avg) nib |= 1 << (3 - b);
      hex += nib.toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

/** 兩個 256-hex pHash 的漢明距離(bit 差異數);無法比較回 9999。 */
export function pHashHamming(a, b) {
  if (!a || !b || a.length !== b.length) return 9999;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** ImageMagick 是否可用(容器建置時已裝;偵測失敗則所有輔助自動略過)。 */
export function magickAvailable() {
  try {
    execFileSync('convert', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 在截圖疊「座標網格 + 刻度標籤」,回疊圖的 base64;失敗回原圖 base64。
 * ss = { w, h } 截圖(smart-resize 後)像素尺寸 —— 即模型座標基準 cw×ch。
 *
 * 關鍵(A 路對齊):刻度「用絕對像素值」標示(與 prompt 要求模型輸出的『這張圖的絕對像素』完全一致),
 * 不再用 0~1000。給通用 VLM(Claude/Qwen)一把可讀的尺規 —— 讓它「讀最近的刻度線再內插」,
 * 而非在美術重、無原生元件的賭場/遊戲畫面憑空估像素(那正是先前 y 軸誤差達數百 px 的主因)。
 *
 * 刻度間距自適應:依短邊挑一個「整齊」的像素步距(~8 條線),整千/半千畫粗線。
 * 垂直(y)是模型最弱的軸:線畫得更明顯、左右兩側都標數字。
 */
function niceStep(span) {
  // 目標約 8 格;取 {100,200,250,500} 級距讓刻度數字好讀。
  const raw = span / 8;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const step = m * pow;
    if (step >= raw) return Math.max(50, Math.round(step));
  }
  return Math.max(50, Math.round(pow * 10));
}
export function gridOverlayB64(srcB64, ss, quality = 82) {
  let src;
  try {
    src = b64ToTmp(srcB64, 'grid-src');
    // 關鍵:輸出 JPEG(非 PNG)。PNG 會把已縮好的 JPEG 重編膨脹 ~8x,多輪對話兩張圖疊起來撐爆 request body。
    const out = join(tmpdir(), `pa-grid-${Date.now()}.jpg`);
    const args = [src, '-fill', 'none'];
    const labels = [];
    const stepX = niceStep(ss.w);
    const stepY = niceStep(ss.h);   // y 軸可用更密的步距(弱軸多給刻度)
    // 垂直線(標 x 像素值):頂/底都標。
    for (let x = stepX; x < ss.w; x += stepX) {
      const strong = x % (stepX * 5) === 0;
      args.push('-strokewidth', strong ? '3' : '1',
        '-stroke', strong ? 'rgba(0,200,255,0.7)' : 'rgba(0,200,255,0.32)',
        '-draw', `line ${x},0 ${x},${ss.h}`);
      labels.push({ t: String(x), x: x + 3, y: 30 });
      labels.push({ t: String(x), x: x + 3, y: ss.h - 10 });
    }
    // 水平線(標 y 像素值):y 弱軸,線稍明顯,左右兩側都標。
    for (let y = stepY; y < ss.h; y += stepY) {
      const strong = y % (stepY * 5) === 0;
      args.push('-strokewidth', strong ? '3' : '1',
        '-stroke', strong ? 'rgba(0,200,255,0.7)' : 'rgba(0,200,255,0.38)',
        '-draw', `line 0,${y} ${ss.w},${y}`);
      labels.push({ t: String(y), x: 6, y: y - 5 });
      labels.push({ t: String(y), x: ss.w - 78, y: y - 5 });
    }
    // 刻度數字(需字型);無字型則只留格線(仍有助對齊)。
    if (FONT_PATH) {
      args.push(...fontArgs(), '-pointsize', '26', '-stroke', 'none');
      for (const l of labels) {
        args.push('-fill', 'rgba(0,0,0,0.6)', '-draw', `rectangle ${l.x - 2},${l.y - 24} ${l.x + 72},${l.y + 6}`);
        args.push('-fill', 'rgba(0,235,255,0.98)', '-annotate', `+${l.x}+${l.y}`, l.t);
      }
    }
    args.push('-quality', String(quality), out);
    execFileSync('convert', args, { stdio: 'ignore', maxBuffer: 16 * 1024 * 1024 });
    return fileToB64(out);
  } catch {
    return srcB64;
  }
}

/**
 * 純視覺偵測畫面最醒目的按鈕中心(高亮 max(r,g,b)>70 且高彩度 max-min>40 的最大色塊)。
 * 回 { x, y, area }(截圖像素座標)或 null。移植自 emulatorRunner.findBrightButton。
 */
export function findBrightButton(srcB64, ss) {
  let src;
  try {
    src = b64ToTmp(srcB64, 'btn-src');
    const DS_W = 480;
    const scale = ss.w / DS_W;
    const mask = join(tmpdir(), `pa-btnmask-${Date.now()}.png`);
    // 不用 -fx(慢且受 IM policy 限制);改用 HSB 通道數學:
    // 轉 HSB → 分離 S(飽和度)與 B(亮度)通道 → 各自 threshold → 相乘(AND)。
    // 對應原判準「夠亮(B>~27%)且高彩度(S>~16%)」的醒目色塊(遊戲主 CTA)。
    execFileSync('convert', [
      src, '-resize', `${DS_W}x`,
      '-colorspace', 'HSB',
      '-separate',                       // 產生 3 張:H(0) S(1) B(2)
      '-delete', '0',                    // 丟掉 H,留 S,B
      '(', '-clone', '0', '-threshold', '16%', ')', // S 二值
      '(', '-clone', '1', '-threshold', '27%', ')', // B 二值
      '-delete', '0-1',                  // 丟原 S,B,留兩張二值
      '-compose', 'multiply', '-composite', // AND
      '-morphology', 'Close', 'Disk:2', '-morphology', 'Open', 'Disk:1', mask,
    ], { stdio: 'ignore', maxBuffer: 16 * 1024 * 1024 });
    const cc = execFileSync('convert', [mask, '-define', 'connected-components:verbose=true',
      '-define', 'connected-components:area-threshold=80', '-connected-components', '8', 'null:'],
      { maxBuffer: 16 * 1024 * 1024 }).toString();
    const dsW = DS_W, dsH = Math.round(ss.h / scale);
    let best = null;
    for (const line of cc.split('\n')) {
      const m = /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+([\d.]+),([\d.]+)\s+(\d+)\s+(\S+)/.exec(line);
      if (!m) continue;
      const w = +m[1], h = +m[2], cx = +m[5], cy = +m[6], area = +m[7], color = m[8];
      const isWhiteFg = /gray(a)?\(255/.test(color) || /white/i.test(color) || /srgba?\(255,255,255/.test(color);
      const isBlackBg = /gray(a)?\(0[,)]/.test(color) || /srgba?\(0,0,0/.test(color) || /black/i.test(color);
      if (!isWhiteFg || isBlackBg) continue;
      if (w >= dsW * 0.9 || h >= dsH * 0.9) continue;
      if (w < 16 || h < 6) continue;
      const ratio = w / h;
      if (ratio < 0.5 || ratio > 10) continue;
      if (!best || area > best.area) best = { cx, cy, area };
    }
    if (!best) return null;
    return { x: Math.round(best.cx * scale), y: Math.round(best.cy * scale), area: Math.round(best.area * scale * scale) };
  } catch {
    return null;
  }
}

/**
 * 偵測畫面上的「按鈕條」(寬扁、圓角、有一定飽和度的長條 UI 元件,如登入頁的 SMS/Account/Play now、
 * 遊戲的 SPIN/開始 長鈕)。與 findBrightButton 的差異:這裡不是找「最亮的單一色塊」(會誤抓金幣/logo),
 * 而是用「形狀」篩選 —— 寬明顯大於高、寬度佔畫面相當比例、位置合理 —— 專抓按鈕列。
 *
 * 用途:VLM 對水平(x)通常準、對垂直(y)常系統性偏低。呼叫端用這些按鈕條「只校正 y」:
 * 若模型點擊的 x 落在某按鈕條的水平跨度內、且 y 差在合理範圍,就把 y 吸到該按鈕中心。
 *
 * 回傳候選按鈕清單 [{ x, y, w, h }](截圖像素座標,x/y 為中心),依面積大到小;失敗或無候選回 []。
 * ss = { w, h } 縮圖(座標空間)尺寸。
 */
export function findButtonBands(srcB64, ss) {
  let src;
  try {
    src = b64ToTmp(srcB64, 'band-src');
    const DS_W = 480;
    const scale = ss.w / DS_W;
    const dsW = DS_W;
    const dsH = Math.max(1, Math.round(ss.h / scale));
    const mask = join(tmpdir(), `pa-bandmask-${Date.now()}.png`);
    // 與 findBrightButton 相同的「夠亮且高彩度」遮罩(按鈕通常是鮮明色塊),但放寬亮度門檻一點,
    // 讓不同顏色的按鈕(黃/藍/紫)都進得來;形狀篩選交給後面的連通元件比例判斷。
    execFileSync('convert', [
      src, '-resize', `${DS_W}x`,
      '-colorspace', 'HSB', '-separate', '-delete', '0',
      '(', '-clone', '0', '-threshold', '18%', ')',
      '(', '-clone', '1', '-threshold', '30%', ')',
      '-delete', '0-1', '-compose', 'multiply', '-composite',
      // 橫向閉運算把按鈕內的文字/圖示縫合成一整條(用寬的水平結構元素)。
      '-morphology', 'Close', 'Rectangle:9x3', '-morphology', 'Open', 'Disk:1', mask,
    ], { stdio: 'ignore', maxBuffer: 16 * 1024 * 1024 });
    const cc = execFileSync('convert', [mask, '-define', 'connected-components:verbose=true',
      '-define', 'connected-components:area-threshold=200', '-connected-components', '8', 'null:'],
      { maxBuffer: 16 * 1024 * 1024 }).toString();
    const cands = [];
    for (const line of cc.split('\n')) {
      const m = /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+([\d.]+),([\d.]+)\s+(\d+)\s+(\S+)/.exec(line);
      if (!m) continue;
      const w = +m[1], h = +m[2], cx = +m[5], cy = +m[6], area = +m[7], color = m[8];
      const isBlackBg = /gray(a)?\(0[,)]/.test(color) || /srgba?\(0,0,0/.test(color) || /black/i.test(color);
      if (isBlackBg) continue;
      // 按鈕條形狀:寬明顯>高(ratio 2.2~9)、寬度佔畫面 28%~92%、高度佔畫面 3%~14%(排除整塊背景/細線)。
      const ratio = w / Math.max(1, h);
      if (ratio < 2.2 || ratio > 9) continue;
      if (w < dsW * 0.28 || w > dsW * 0.92) continue;
      if (h < dsH * 0.03 || h > dsH * 0.14) continue;
      // 水平大致置中(按鈕列通常置中):中心 x 落在畫面 30%~70%。
      if (cx < dsW * 0.30 || cx > dsW * 0.70) continue;
      cands.push({
        x: Math.round(cx * scale),
        y: Math.round(cy * scale),
        w: Math.round(w * scale),
        h: Math.round(h * scale),
        area,
      });
    }
    // 依面積大到小(較大的長條較可能是主按鈕)。
    cands.sort((a, b) => b.area - a.area);
    return cands.map(({ x, y, w, h }) => ({ x, y, w, h }));
  } catch {
    return [];
  }
}

/**
 * 在截圖畫紅十字 + 圓圈 + 座標標籤(標記 AI 這一步點在哪),回 annotated 圖 base64;失敗回 null。
 * 標記大小依截圖尺寸自適應(小圖用小標記)。
 */
export function annotateTapB64(srcB64, x, y, label, ss) {
  let src;
  try {
    src = b64ToTmp(srcB64, 'ann-src');
    const out = join(tmpdir(), `pa-ann-${Date.now()}.png`);
    const base = Math.max(ss.w, ss.h);
    const cross = Math.max(30, Math.round(base * 0.03));
    const r = Math.max(20, Math.round(base * 0.02));
    const sw = Math.max(3, Math.round(base * 0.002));
    const ps = Math.max(18, Math.round(base * 0.012));
    // 標籤框在點的右側;若太靠右則畫左側,避免超出畫面。
    const boxW = 220;
    const labelLeft = x + r + 10 + boxW > ss.w ? x - r - 10 - boxW : x + r + 10;
    // 標記本體(紅十字 + 圓圈)不需字型,一定畫;座標文字標籤僅在有字型時加。
    const markArgs = [
      src,
      '-stroke', 'red', '-strokewidth', String(sw), '-fill', 'none',
      '-draw', `line ${x - cross},${y} ${x + cross},${y}`,
      '-draw', `line ${x},${y - cross} ${x},${y + cross}`,
      '-fill', 'rgba(255,0,0,0.28)', '-stroke', 'red', '-strokewidth', String(sw),
      '-draw', `circle ${x},${y} ${x},${y - r}`,
      '-fill', 'red', '-stroke', 'none', '-draw', `circle ${x},${y} ${x},${y - Math.max(4, Math.round(r * 0.16))}`,
    ];
    if (FONT_PATH) {
      markArgs.push(
        '-fill', 'rgba(255,0,0,0.85)', '-stroke', 'none',
        '-draw', `roundrectangle ${labelLeft},${y - 26} ${labelLeft + boxW},${y + 26} 6,6`,
        ...fontArgs(), '-fill', 'white', '-pointsize', String(ps),
        '-annotate', `+${labelLeft + 10}+${y + 6}`, `${label} (${x},${y})`,
      );
    }
    markArgs.push(out);
    execFileSync('convert', markArgs, { stdio: 'ignore', maxBuffer: 16 * 1024 * 1024 });
    return fileToB64(out);
  } catch {
    return null;
  }
}
