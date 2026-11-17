import { Blob as NodeBlob } from 'node:buffer';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// jsdom 的 Blob 沒有 arrayBuffer() / slice().arrayBuffer();瀏覽器都有。換成 Node 的 Blob(介面與瀏覽器相同)。
globalThis.Blob = NodeBlob as unknown as typeof Blob;
import { ZipError, crc32, extract, readZip, rootedEntries, safeName, sha256Hex, writeZip, type Inflate } from './memoryZip.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const nodeInflate: Inflate = async (blob, max) => {
  const out = new Uint8Array(inflateRawSync(new Uint8Array(await blob.arrayBuffer())));
  if (out.length > max) throw new ZipError('tooLarge');
  return out;
};

/** 手工組一個 deflate 的 zip(模擬使用者用系統工具重新壓縮)。 */
function deflateZip(files: Array<[string, string]>): Blob {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const raw = enc.encode(text);
    const comp = new Uint8Array(deflateRawSync(raw));
    const n = enc.encode(name);
    const crc = crc32(raw);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 8, true);
    h.setUint32(14, crc, true); h.setUint32(18, comp.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, n.length, true);
    parts.push(new Uint8Array(h.buffer), n, comp);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(10, 8, true);
    c.setUint32(16, crc, true); c.setUint32(20, comp.length, true); c.setUint32(24, raw.length, true); c.setUint16(28, n.length, true); c.setUint32(42, offset, true);
    const entry = new Uint8Array(46 + n.length); entry.set(new Uint8Array(c.buffer)); entry.set(n, 46);
    central.push(entry);
    offset += 30 + n.length + comp.length;
  }
  const size = central.reduce((a, e) => a + e.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)] as BlobPart[]);
}

describe('memoryZip', () => {
  it('CRC-32 matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips text and binary files, including non-ASCII names', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 1, 2, 3]);
    const zip = await writeZip([
      { name: 'memory.md', data: enc.encode('# 記憶地圖\n') },
      { name: 'screenshots/page_0000aaa1.png', data: new Blob([png]) },
      { name: 'data/說明.json', data: enc.encode('{"a":1}') },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['memory.md', 'screenshots/page_0000aaa1.png', 'data/說明.json']);
    expect(dec.decode(await extract(zip, entries[0]!))).toBe('# 記憶地圖\n');
    expect([...(await extract(zip, entries[1]!))]).toEqual([...png]);
    expect(dec.decode(await extract(zip, entries[2]!))).toBe('{"a":1}');
  });

  it('reads deflate entries (a folder re-zipped with a system tool)', async () => {
    const zip = deflateZip([['export/manifest.json', '{"format":"playagent-memory"}'], ['export/memory.md', '# hi '.repeat(200)]]);
    const map = rootedEntries(await readZip(zip));
    expect([...map.keys()].sort()).toEqual(['manifest.json', 'memory.md']);
    expect(dec.decode(await extract(zip, map.get('memory.md')!, nodeInflate))).toBe('# hi '.repeat(200));
  });

  it('rejects path traversal, absolute paths and drive letters', () => {
    for (const bad of ['../x.md', 'a/../../x', '/etc/passwd', 'C:\\x.md', 'a\\..\\b']) {
      expect(() => safeName(bad), bad).toThrow(ZipError);
    }
    expect(safeName('screenshots\\page_1.png')).toBe('screenshots/page_1.png');
  });

  it('detects corrupted content through the CRC', async () => {
    const zip = await writeZip([{ name: 'a.txt', data: enc.encode('hello') }]);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const at = 30 + 'a.txt'.length;
    bytes[at] = bytes[at]! ^ 0xff;
    const broken = new Blob([bytes]);
    await expect(extract(broken, (await readZip(broken))[0]!)).rejects.toThrow(/corrupt/);
  });

  it('rejects something that is not a zip', async () => {
    await expect(readZip(new Blob([enc.encode('not a zip at all, just text')]))).rejects.toThrow(/notZip/);
  });

  it('computes SHA-256 hex', async () => {
    expect(await sha256Hex(enc.encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
