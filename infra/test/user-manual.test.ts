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
const unique = (names: string[]) => [...new Set(names)].sort();

/** 每份 README 只能引用自己語系的截圖資料夾(資料夾名稱 = web 的 Locale id)。 */
const LOCALE_OF = {
  'README.md': 'en',
  'README_ZH.md': 'zh-Hant',
  'README_CN.md': 'zh-Hans',
  'README_JP.md': 'ja',
  'README_KR.md': 'ko',
} as const;
const LOCALES = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'] as const;

/** `docs/screenshots/<locale>/<name>.png` 的 [語系, 檔名] 清單。 */
const localeImagesIn = (text: string) =>
  [...text.matchAll(/docs\/screenshots\/(zh-Hant|en|zh-Hans|ja|ko)\/([\w.-]+\.png)/g)].map(
    (m) => [m[1]!, m[2]!] as const,
  );
const pngsIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.png')).sort();

// 新的「每語系一個資料夾」版面要等 FEAT-004 拍出圖之後才會存在;在那之前 README 與舊的平面
// PNG 維持原樣,新版斷言以 docs/screenshots/en 是否存在為閘門。FEAT-005 把 README 改完後,
// 這個閘門與下面的 legacy 區塊一起刪掉。
const localeDirsExist = existsSync(join(shots, 'en'));

describe('illustrated user manual in all five READMEs', () => {
  test('every non-wildcard route in App.tsx is documented in all five languages', () => {
    expect(routes).toContain('/live/:jobId');
    expect(routes.length).toBeGreaterThanOrEqual(16);
    // 每個路由都要以 `#/apps` 這種反引號形式出現:否則 #/apps 會被 #/apps/:appId 代為過關,
    // 子路由就可以悄悄漏掉。手冊的每個路由標題都帶「Route: `#X`」。
    for (const { file, text } of readmes) {
      for (const route of routes) expect(text, `${file} ${route}`).toContain(`\`#${route}\``);
    }
  });
});

describe.skipIf(!localeDirsExist)('per-locale screenshot directories', () => {
  test('each README references only its own locale directory', () => {
    for (const { file, text } of readmes) {
      const refs = localeImagesIn(text);
      expect(refs.length, file).toBeGreaterThan(0);
      for (const [locale, name] of refs) expect(locale, `${file} ${name}`).toBe(LOCALE_OF[file]);
    }
  });

  test('all five READMEs reference the identical filename set', () => {
    const names = (text: string) => unique(localeImagesIn(text).map(([, n]) => n));
    const expected = names(readmes[0]!.text);
    for (const { file, text } of readmes) expect(names(text), file).toEqual(expected);
  });

  test('all five locale directories hold the same filename set', () => {
    const expected = pngsIn(join(shots, 'en'));
    expect(expected.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      expect(existsSync(join(shots, locale)), locale).toBe(true);
      expect(pngsIn(join(shots, locale)), locale).toEqual(expected);
    }
  });

  test('every referenced screenshot exists on disk', () => {
    for (const { file, text } of readmes) {
      for (const [locale, name] of localeImagesIn(text)) {
        expect(existsSync(join(shots, locale, name)), `${file} ${locale}/${name}`).toBe(true);
      }
    }
  });

  test('no unreferenced screenshot sits in the public repository', () => {
    for (const { file, text } of readmes) {
      const locale = LOCALE_OF[file];
      const referenced = new Set(localeImagesIn(text).map(([, n]) => n));
      for (const img of pngsIn(join(shots, locale))) expect(referenced.has(img), `${locale}/${img}`).toBe(true);
    }
  });

  test('no flat screenshot is left behind next to the locale directories', () => {
    expect(readdirSync(shots).filter((f) => f.endsWith('.png'))).toEqual([]);
  });
});

// legacy:舊的平面版面(docs/screenshots/NN-slug.png),只在還沒有語系資料夾時驗證。
describe.skipIf(localeDirsExist)('legacy flat screenshots (until FEAT-004/005)', () => {
  const flatImagesIn = (text: string) =>
    [...text.matchAll(/docs\/screenshots\/([\w.-]+\.png)/g)].map((m) => m[1]!).sort();

  test('every referenced screenshot exists on disk', () => {
    for (const { file, text } of readmes) {
      const images = unique(flatImagesIn(text));
      expect(images.length, file).toBeGreaterThan(0);
      for (const img of images) expect(existsSync(join(shots, img)), `${file} ${img}`).toBe(true);
    }
  });

  test('all five READMEs reference the identical image set', () => {
    const expected = unique(flatImagesIn(readmes[0]!.text));
    for (const { file, text } of readmes) expect(unique(flatImagesIn(text)), file).toEqual(expected);
  });

  test('no unreferenced screenshot sits in the public repository', () => {
    const referenced = new Set(unique(flatImagesIn(readmes[0]!.text)));
    const onDisk = pngsIn(shots);
    expect(onDisk.length).toBeGreaterThan(0);
    for (const img of onDisk) expect(referenced.has(img), img).toBe(true);
  });
});
