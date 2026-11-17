/**
 * 記憶匯出 / 匯入用的最小 zip 讀寫(不引入套件)。
 *
 * 寫:只用「儲存」(不壓縮)—— 內容幾乎全是 PNG,本身已壓縮,再壓只是多花時間。
 *     檔案內容保留成 Blob 片段串起來,數百 MB 的截圖不需要整份複製進一塊記憶體。
 * 讀:支援「儲存」與「deflate」—— 使用者解開資料夾、改了 memory.md 再用系統工具壓回去,
 *     通常是 deflate。不支援 ZIP64(> 4 GB)與加密。
 *
 * 安全:拒絕絕對路徑、`..`、磁碟代號;解壓時超過宣告大小就中止(防 zip 炸彈)。
 */

export class ZipError extends Error {
  constructor(readonly code: ZipErrorCode, readonly detail = '') {
    super(detail ? `${code}: ${detail}` : code);
  }
}
export type ZipErrorCode = 'notZip' | 'zip64' | 'encrypted' | 'badName' | 'tooLarge' | 'tooMany' | 'method' | 'corrupt';

export const ZIP_LIMITS = { entries: 5000, entryBytes: 64 * 1024 * 1024, totalBytes: 3.5 * 1024 * 1024 * 1024 } as const;

// ───────────── CRC-32 / SHA-256 ─────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, prev = 0): number {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ───────────── 寫 ─────────────

export interface ZipInput {
  name: string;
  /** 內容;寫入時只讀一次,用來算 CRC。 */
  data: Uint8Array | Blob;
}

const enc = new TextEncoder();

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function safeName(raw: string): string {
  const name = raw.replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((s) => s === '..' || s === '.')) {
    throw new ZipError('badName', raw.slice(0, 80));
  }
  return name;
}

async function bytesOf(d: Uint8Array | Blob): Promise<Uint8Array> {
  // ArrayBuffer.isView 而非 instanceof:跨 realm(iframe、測試環境)的 Uint8Array 也認得。
  return ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(await d.arrayBuffer());
}

/** 把檔案打包成 zip(儲存,不壓縮)。onProgress(已處理檔數, 總檔數)。 */
export async function writeZip(files: ZipInput[], opts: { now?: Date; onProgress?: (done: number, total: number) => void } = {}): Promise<Blob> {
  if (files.length > 0xfffe) throw new ZipError('tooMany', String(files.length));
  const { time, date } = dosTime(opts.now ?? new Date());
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let done = 0;
  for (const f of files) {
    const nameBytes = enc.encode(safeName(f.name));
    const bytes = await bytesOf(f.data);
    const crc = crc32(bytes);
    const size = bytes.length;
    if (offset + 30 + nameBytes.length + size > 0xfffffffe) throw new ZipError('tooLarge', 'zip > 4 GB');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // 檔名是 UTF-8
    local.setUint16(8, 0, true); // 儲存
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    // Blob 輸入原樣放回片段(不保留剛讀出的位元組);Uint8Array 直接放。
    parts.push(new Uint8Array(local.buffer), nameBytes as BlobPart, (ArrayBuffer.isView(f.data) ? bytes : f.data) as BlobPart);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    const entry = new Uint8Array(46 + nameBytes.length);
    entry.set(new Uint8Array(cd.buffer), 0);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += 30 + nameBytes.length + size;
    opts.onProgress?.(++done, files.length);
  }
  const cdSize = central.reduce((n, e) => n + e.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}

// ───────────── 讀 ─────────────

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  offset: number;
}

async function slice(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

const dec = new TextDecoder('utf-8');

/** 讀 zip 目錄(不解壓內容)。 */
export async function readZip(blob: Blob): Promise<ZipEntry[]> {
  if (blob.size < 22) throw new ZipError('notZip');
  const tailLen = Math.min(blob.size, 22 + 0xffff);
  const tail = await slice(blob, blob.size - tailLen, blob.size);
  let eo = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  }
  if (eo < 0) throw new ZipError('notZip');
  const count = tail.getUint16(eo + 10, true);
  const cdSize = tail.getUint32(eo + 12, true);
  const cdOffset = tail.getUint32(eo + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError('zip64');
  if (count > ZIP_LIMITS.entries) throw new ZipError('tooMany', String(count));
  if (cdOffset + cdSize > blob.size) throw new ZipError('corrupt', 'central directory');
  const cd = await slice(blob, cdOffset, cdOffset + cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw new ZipError('corrupt', `entry ${i}`);
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    const compressedSize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const n = cd.getUint16(p + 28, true);
    const m = cd.getUint16(p + 30, true);
    const k = cd.getUint16(p + 32, true);
    const offset = cd.getUint32(p + 42, true);
    const rawName = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, n));
    p += 46 + n + m + k;
    if (rawName.endsWith('/')) continue; // 資料夾項目
    if (flags & 0x1) throw new ZipError('encrypted', rawName);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('zip64');
    if (size > ZIP_LIMITS.entryBytes) throw new ZipError('tooLarge', rawName);
    total += size;
    if (total > ZIP_LIMITS.totalBytes) throw new ZipError('tooLarge', 'total');
    out.push({ name: safeName(rawName), method, compressedSize, size, crc, offset });
  }
  return out;
}

/** 解壓用的 inflate(預設用瀏覽器的 DecompressionStream;測試可注入)。 */
export type Inflate = (data: Blob, maxBytes: number) => Promise<Uint8Array>;

export const browserInflate: Inflate = async (data, maxBytes) => {
  const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > maxBytes) { await reader.cancel(); throw new ZipError('tooLarge', 'inflated size exceeds the declared size'); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

/** 取出一個檔案的內容,並驗證 CRC 與大小。 */
export async function extract(blob: Blob, e: ZipEntry, inflate: Inflate = browserInflate): Promise<Uint8Array> {
  const head = await slice(blob, e.offset, e.offset + 30);
  if (head.getUint32(0, true) !== 0x04034b50) throw new ZipError('corrupt', e.name);
  const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = blob.slice(start, start + e.compressedSize);
  let bytes: Uint8Array;
  if (e.method === 0) bytes = new Uint8Array(await raw.arrayBuffer());
  else if (e.method === 8) bytes = await inflate(raw, e.size);
  else throw new ZipError('method', `${e.name}: ${e.method}`);
  if (bytes.length !== e.size || crc32(bytes) !== e.crc) throw new ZipError('corrupt', e.name);
  return bytes;
}

/**
 * 找出匯出資料夾的根:使用者可能把整個資料夾再壓一次,檔名會多一層 `資料夾名/`。
 * 回傳一個「去掉根之後的名稱 → 項目」的表。
 */
export function rootedEntries(entries: ZipEntry[], marker = 'manifest.json'): Map<string, ZipEntry> {
  const hits = entries.filter((e) => e.name === marker || e.name.endsWith(`/${marker}`)).sort((a, b) => a.name.length - b.name.length);
  const root = hits[0] ? hits[0].name.slice(0, hits[0].name.length - marker.length) : '';
  const map = new Map<string, ZipEntry>();
  for (const e of entries) if (e.name.startsWith(root)) map.set(e.name.slice(root.length), e);
  return map;
}
