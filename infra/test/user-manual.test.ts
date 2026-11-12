import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const files = ['README.md', 'README_ZH.md', 'README_CN.md', 'README_JP.md', 'README_KR.md'] as const;
const readmes = files.map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
const app = readFileSync(join(root, 'web', 'src', 'App.tsx'), 'utf8');
const shots = join(root, 'docs', 'screenshots');

// 路由清單直接從 App.tsx 解析,手冊的頁面盤點就不會和真正的路由各走各的。
const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!).filter((p) => p !== '*');
const imagesIn = (text: string) =>
  [...text.matchAll(/docs\/screenshots\/([\w.-]+\.png)/g)].map((m) => m[1]!).sort();
const unique = (names: string[]) => [...new Set(names)].sort();

describe('illustrated user manual in all five READMEs', () => {
  test('every non-wildcard route in App.tsx is documented in all five languages', () => {
    expect(routes).toContain('/live/:jobId');
    expect(routes.length).toBeGreaterThanOrEqual(16);
    // 比對加了反引號的 `#/apps`,而不是裸的 #/apps:後者會被 #/apps/:appId 這類帶參數的
    // 子路由順便滿足,於是少寫一頁也測得過。手冊每個條目都以 Route: `#X` 標註路由。
    for (const { file, text } of readmes) {
      for (const route of routes) expect(text, `${file} ${route}`).toContain(`\`#${route}\``);
    }
  });

  test('every referenced screenshot exists on disk', () => {
    for (const { file, text } of readmes) {
      const images = unique(imagesIn(text));
      expect(images.length, file).toBeGreaterThan(0);
      for (const img of images) expect(existsSync(join(shots, img)), `${file} ${img}`).toBe(true);
    }
  });

  test('all five READMEs reference the identical image set', () => {
    const expected = unique(imagesIn(readmes[0]!.text));
    for (const { file, text } of readmes) expect(unique(imagesIn(text)), file).toEqual(expected);
  });

  test('no unreferenced screenshot sits in the public repository', () => {
    const referenced = new Set(unique(imagesIn(readmes[0]!.text)));
    const onDisk = readdirSync(shots).filter((f) => f.endsWith('.png')).sort();
    expect(onDisk.length).toBeGreaterThan(0);
    for (const img of onDisk) expect(referenced.has(img), img).toBe(true);
  });
});
