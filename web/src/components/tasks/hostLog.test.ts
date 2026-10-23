import { describe, expect, it } from 'vitest';
import { parseLogcat, clockOffset } from './logcat.ts';

/**
 * Windows 主機 log(worker/windows-host/gamelift/host.ps1)刻意輸出成 logcat 行格式,
 * 好讓前端的 parseLogcat / LogcatView 原封不動重用 —— 不必為它另造一條管線。
 *
 * 這組測試守的是那個「刻意」:格式一旦漂掉,LogcatView 會安靜地顯示 0 行。
 * 不是跳錯、不是空狀態,就是一片空白,而這正是 Windows 任務最需要看到東西的時候。
 * 下面的樣本是用 PowerShell 的同一段格式字串實際產生出來的,不是手寫的理想值。
 */

/** host.ps1 FlushLog 實際產出的一段(PowerShell 跑出來後貼回來)。 */
const CHUNK = [
  '# step=0 at=2026-10-23T03:15:58.1530761Z pid=1 dev=1792725358.153 sent=1792725358153',
  '1792725358.153  1  0  I  host: start job=job-abc user=gamelift session=1',
  '1792725359.201  1  0  I  install: innoextract 耗時 3s,解出 0 個 exe',
  '1792725360.500  1  0  W  install: innoextract 失敗或不是 Inno Setup:Warning: Unexpected setup data version: 6.3.0',
  '1792725361.000  1  0  E  install: 安裝程式超過 600 秒沒有結束(Inno /VERYSILENT),判定卡住並終止',
  '1792725362.000  1  0  E  runner: runner stderr 尾段 | 第二行併成一行',
].join('\n');

describe('Windows 主機 log 的行格式', () => {
  it('parseLogcat 解得出每一行(格式漂掉會變成 0 行空白面板)', () => {
    const { lines } = parseLogcat(CHUNK);
    expect(lines).toHaveLength(5);
  });

  it('等級字母對得上,錯誤那幾行篩得出來', () => {
    const { lines } = parseLogcat(CHUNK);
    expect(lines.map((l) => l.level)).toEqual(['I', 'I', 'W', 'E', 'E']);
    // 使用者在面板上選「只看警告和錯誤」時要剩這三行。
    expect(lines.filter((l) => l.level === 'W' || l.level === 'E')).toHaveLength(3);
  });

  it('來源標籤是階段名,可以據此看出是哪一步失敗的', () => {
    const { lines } = parseLogcat(CHUNK);
    expect([...new Set(lines.map((l) => l.tag))]).toEqual(['host', 'install', 'runner']);
  });

  it('訊息裡的冒號不會被吃掉(innoextract 的版本訊息就靠它)', () => {
    const { lines } = parseLogcat(CHUNK);
    const warn = lines.find((l) => l.level === 'W')!;
    // parseLogcat 以第一個冒號切 tag / msg,後面的冒號必須原樣保留 ——
    // 否則「Unexpected setup data version: 6.3.0」這個關鍵線索會被截斷。
    expect(warn.msg).toContain('Unexpected setup data version: 6.3.0');
  });

  it('時間換算成 runner 時鐘;主機只有一個時鐘所以位移是 0', () => {
    expect(clockOffset(CHUNK)).toBe(0);
    const { lines } = parseLogcat(CHUNK);
    expect(lines[0]!.t).toBe(1792725358153);
  });

  it('多行訊息已經在主機端併成一行(logcat 一行一筆)', () => {
    const { lines } = parseLogcat(CHUNK);
    expect(lines.at(-1)!.msg).toBe('runner stderr 尾段 | 第二行併成一行');
  });

  it('標頭行不會被當成 log 內容', () => {
    const { lines } = parseLogcat(CHUNK);
    expect(lines.some((l) => l.raw.startsWith('#'))).toBe(false);
  });
});
