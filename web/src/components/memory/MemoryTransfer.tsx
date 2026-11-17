import { useRef, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../../api/client.ts';
import { fill, pick5, type L5 } from '../../i18n/locale5.ts';
import type { RLang } from '../report/reportText.ts';
import { ZipError, extract, readZip, rootedEntries, sha256Hex, writeZip, type ZipEntry, type ZipInput } from './memoryZip.ts';

/**
 * 記憶地圖的匯出 / 匯入(zip)。
 *
 * zip 內容:memory.md(給 AI 與人讀)+ screenshots/<pageId>.png + data/*.json(匯入用)+ manifest.json。
 * zip 在瀏覽器組與拆:截圖可能數百 MB,不經過 API。匯入以 data/ 為準,memory.md 只是閱讀用。
 */

interface ExportPayload {
  manifest: Record<string, unknown> & { app: { id: string; name: string } };
  data: { structure: unknown; edits: unknown; hints: { hints: unknown[] }; meta: unknown };
  markdown: string;
  screenshots: Array<{ pageId: string; path: string; url: string }>;
}

export interface ImportSummary {
  fromApp: string;
  fromAppName?: string;
  exportedAt?: string;
  pages: { added: number; merged: number };
  edges: { added: number; merged: number };
  hints: { added: number; skipped: number };
  routes: { added: number; skipped: number };
  renames: number;
  opEdits: number;
  deleted: { pages: number; edges: number };
  screenshots: number;
  warnings: string[];
}

interface Pending {
  file: File;
  map: Map<string, ZipEntry>;
  body: Record<string, unknown>;
  summary: ImportSummary;
  unverified: boolean;
}

const T = {
  exportBtn: ['匯出記憶(zip)', 'Export memory (zip)', '导出记忆(zip)', 'メモリをエクスポート(zip)', '메모리 내보내기(zip)'],
  importBtn: ['匯入記憶', 'Import memory', '导入记忆', 'メモリをインポート', '메모리 가져오기'],
  exportHint: [
    '下載一個 zip:memory.md(AI 讀了就能沿用這份記憶)、每個畫面的截圖、以及匯回用的原始資料。',
    'Download a zip with memory.md (an AI can read it and reuse this memory), a screenshot of every screen, and the raw data for importing it back.',
    '下载一个 zip:memory.md(AI 读了就能沿用这份记忆)、每个画面的截图、以及导回用的原始数据。',
    'memory.md(AI が読めばこのメモリを再利用できます)、各画面のスクリーンショット、再インポート用の元データを含む zip をダウンロードします。',
    'memory.md(AI가 읽으면 이 메모리를 그대로 사용할 수 있음), 각 화면의 스크린샷, 다시 가져오기용 원본 데이터가 담긴 zip을 내려받습니다.',
  ],
  importHint: [
    '匯入另一份匯出的 zip,與這個應用現有的記憶合併。寫入前會先顯示預覽。',
    'Import a zip exported earlier and merge it with this app\'s current memory. A preview is shown before anything is written.',
    '导入另一份导出的 zip,与这个应用现有的记忆合并。写入前会先显示预览。',
    'エクスポート済みの zip をインポートし、このアプリの現在のメモリと統合します。書き込む前にプレビューを表示します。',
    '내보낸 zip을 가져와 이 앱의 현재 메모리와 병합합니다. 기록하기 전에 미리 보기를 표시합니다.',
  ],
  preparing: ['準備匯出資料…', 'Preparing export…', '准备导出数据…', 'エクスポートを準備中…', '내보내기 준비 중…'],
  downloading: ['下載截圖 {done}/{total}', 'Downloading screenshots {done}/{total}', '下载截图 {done}/{total}', 'スクリーンショットをダウンロード中 {done}/{total}', '스크린샷 다운로드 중 {done}/{total}'],
  zipping: ['打包 zip…', 'Building zip…', '打包 zip…', 'zip を作成中…', 'zip 만드는 중…'],
  exported: ['已匯出:{pages} 個畫面、{shots} 張截圖。', 'Exported {pages} screens and {shots} screenshots.', '已导出:{pages} 个画面、{shots} 张截图。', '{pages} 画面と {shots} 枚のスクリーンショットをエクスポートしました。', '화면 {pages}개, 스크린샷 {shots}장을 내보냈습니다.'],
  shotFailed: ['{n} 張截圖下載失敗,zip 裡沒有這幾張。', '{n} screenshots could not be downloaded and are not in the zip.', '{n} 张截图下载失败,zip 里没有这几张。', '{n} 枚のスクリーンショットをダウンロードできず、zip に含まれていません。', '스크린샷 {n}장을 내려받지 못해 zip에 포함되지 않았습니다.'],
  reading: ['讀取 zip…', 'Reading zip…', '读取 zip…', 'zip を読み込み中…', 'zip 읽는 중…'],
  verifying: ['驗證檔案完整性 {done}/{total}', 'Verifying files {done}/{total}', '验证文件完整性 {done}/{total}', 'ファイルを検証中 {done}/{total}', '파일 검증 중 {done}/{total}'],
  previewing: ['計算合併結果…', 'Calculating the merge…', '计算合并结果…', '統合結果を計算中…', '병합 결과 계산 중…'],
  previewTitle: ['匯入預覽', 'Import preview', '导入预览', 'インポートのプレビュー', '가져오기 미리 보기'],
  from: ['來源:{app}(匯出時間 {at})', 'Source: {app} (exported {at})', '来源:{app}(导出时间 {at})', 'ソース:{app}(エクスポート日時 {at})', '원본: {app} (내보낸 시각 {at})'],
  rowPages: ['畫面', 'Screens', '画面', '画面', '화면'],
  rowEdges: ['路徑', 'Paths', '路径', '経路', '경로'],
  rowHints: ['應用記憶', 'App memory', '应用记忆', 'アプリメモリ', '앱 메모리'],
  rowRoutes: ['路線', 'Routes', '路线', 'ルート', '경로 묶음'],
  added: ['新增 {n}', '{n} added', '新增 {n}', '追加 {n}', '추가 {n}'],
  merged: ['併入既有 {n}', '{n} merged into existing', '并入现有 {n}', '既存と統合 {n}', '기존과 병합 {n}'],
  skipped: ['略過 {n}', '{n} skipped', '略过 {n}', 'スキップ {n}', '건너뜀 {n}'],
  other: ['另有:改名 {renames}、操作修正 {ops}、已刪除標記 {deleted}、截圖 {shots} 張', 'Also: {renames} renames, {ops} action fixes, {deleted} deletion marks, {shots} screenshots', '另有:改名 {renames}、操作修正 {ops}、已删除标记 {deleted}、截图 {shots} 张', 'その他:名前変更 {renames}、操作の修正 {ops}、削除マーク {deleted}、スクリーンショット {shots} 枚', '기타: 이름 변경 {renames}, 동작 수정 {ops}, 삭제 표시 {deleted}, 스크린샷 {shots}장'],
  rules: [
    '合併規則:認得出是同一個畫面就合併(次數相加),認不出就新增。這個應用已有的改名、路線、應用記憶都保留,只補沒有的。匯入的畫面會標記來源。',
    'Merge rules: screens recognised as the same are merged (counts are added); others are added as new. This app\'s existing renames, routes and app memory are kept; only missing items are added. Imported screens are tagged with their source.',
    '合并规则:认得出是同一个画面就合并(次数相加),认不出就新增。这个应用已有的改名、路线、应用记忆都保留,只补没有的。导入的画面会标记来源。',
    '統合ルール:同じ画面と判断できたものは統合し(回数は加算)、判断できないものは新規追加します。このアプリの既存の名前変更・ルート・アプリメモリはそのまま残し、足りないものだけ追加します。インポートした画面には出所が記録されます。',
    '병합 규칙: 같은 화면으로 인식되면 병합하고(횟수 합산) 그렇지 않으면 새로 추가합니다. 이 앱의 기존 이름 변경, 경로, 앱 메모리는 유지하고 없는 항목만 추가합니다. 가져온 화면에는 출처가 표시됩니다.',
  ],
  mdNote: [
    '匯入讀的是 zip 裡的 data/ 資料;memory.md 只是閱讀用,修改它不影響匯入結果。',
    'Import reads the data/ folder in the zip. memory.md is for reading only; editing it does not change what is imported.',
    '导入读的是 zip 里的 data/ 数据;memory.md 只是阅读用,修改它不影响导入结果。',
    'インポートは zip 内の data/ を読み込みます。memory.md は閲覧用で、編集してもインポート結果は変わりません。',
    '가져오기는 zip의 data/ 폴더를 읽습니다. memory.md는 읽기 전용이며 수정해도 가져오는 내용은 바뀌지 않습니다.',
  ],
  unverified: [
    '這個 zip 沒有檔案雜湊(manifest.files),無法驗證內容是否完整。',
    'This zip has no file hashes (manifest.files), so its contents cannot be verified as complete.',
    '这个 zip 没有文件哈希(manifest.files),无法验证内容是否完整。',
    'この zip にはファイルのハッシュ(manifest.files)がないため、内容が完全か検証できません。',
    '이 zip에는 파일 해시(manifest.files)가 없어 내용이 온전한지 검증할 수 없습니다.',
  ],
  confirm: ['確認匯入', 'Import', '确认导入', 'インポートする', '가져오기'],
  cancel: ['取消', 'Cancel', '取消', 'キャンセル', '취소'],
  applying: ['寫入記憶…', 'Writing memory…', '写入记忆…', 'メモリを書き込み中…', '메모리 기록 중…'],
  uploading: ['上傳截圖 {done}/{total}', 'Uploading screenshots {done}/{total}', '上传截图 {done}/{total}', 'スクリーンショットをアップロード中 {done}/{total}', '스크린샷 업로드 중 {done}/{total}'],
  imported: ['匯入完成:新增 {added} 個畫面、併入 {merged} 個。', 'Import complete: {added} screens added, {merged} merged.', '导入完成:新增 {added} 个画面、并入 {merged} 个。', 'インポート完了:{added} 画面を追加、{merged} 画面を統合しました。', '가져오기 완료: 화면 {added}개 추가, {merged}개 병합.'],
  uploadFailed: ['{n} 張截圖上傳失敗;記憶已寫入,這幾個畫面暫時沒有截圖。', '{n} screenshots failed to upload. The memory was written; those screens have no screenshot for now.', '{n} 张截图上传失败;记忆已写入,这几个画面暂时没有截图。', '{n} 枚のスクリーンショットのアップロードに失敗しました。メモリは書き込み済みで、これらの画面には当面スクリーンショットがありません。', '스크린샷 {n}장 업로드에 실패했습니다. 메모리는 기록되었으며 해당 화면에는 당분간 스크린샷이 없습니다.'],
  errRunning: ['這個應用有測試正在進行,等測試結束再匯入記憶。', 'A test is running on this app. Import the memory after it finishes.', '这个应用有测试正在进行,等测试结束再导入记忆。', 'このアプリでテストが実行中です。終了してからインポートしてください。', '이 앱에서 테스트가 진행 중입니다. 테스트가 끝난 뒤 가져오십시오.'],
  errAlready: ['這份匯出檔已經匯入過這個應用;再匯一次會讓造訪與成功次數重複計算。', 'This export has already been imported into this app. Importing it again would count visits and successes twice.', '这份导出文件已经导入过这个应用;再导一次会让访问与成功次数重复计算。', 'このエクスポートは既にこのアプリへインポート済みです。再度インポートすると訪問回数と成功回数が二重に数えられます。', '이 내보내기 파일은 이미 이 앱에 가져왔습니다. 다시 가져오면 방문 및 성공 횟수가 중복 집계됩니다.'],
  errChanged: ['預覽之後記憶被修改過,請重新匯入。', 'The memory changed after the preview. Import again.', '预览之后记忆被修改过,请重新导入。', 'プレビュー後にメモリが変更されました。もう一度インポートしてください。', '미리 보기 이후 메모리가 변경되었습니다. 다시 가져오십시오.'],
  errNotBundle: ['這不是 PlayAgent Checker 匯出的記憶 zip(找不到 manifest.json 或格式不符)。', 'This is not a memory zip exported from PlayAgent Checker (manifest.json is missing or has the wrong format).', '这不是 PlayAgent Checker 导出的记忆 zip(找不到 manifest.json 或格式不符)。', 'PlayAgent Checker からエクスポートしたメモリ zip ではありません(manifest.json がないか形式が違います)。', 'PlayAgent Checker에서 내보낸 메모리 zip이 아닙니다(manifest.json이 없거나 형식이 다릅니다).'],
  errHash: ['檔案內容與 manifest 記錄的雜湊不符:{file}。zip 可能損壞或被修改過。', 'A file does not match the hash recorded in the manifest: {file}. The zip may be damaged or modified.', '文件内容与 manifest 记录的哈希不符:{file}。zip 可能损坏或被修改过。', 'ファイルの内容が manifest のハッシュと一致しません:{file}。zip が破損しているか変更されています。', '파일 내용이 manifest에 기록된 해시와 다릅니다: {file}. zip이 손상되었거나 수정되었을 수 있습니다.'],
  errZip: ['無法讀取這個 zip({code})。', 'This zip could not be read ({code}).', '无法读取这个 zip({code})。', 'この zip を読み込めません({code})。', '이 zip을 읽을 수 없습니다({code}).'],
  errBody: ['資料量太大,無法一次匯入(超過 5 MB)。', 'The data is too large to import in one request (over 5 MB).', '数据量太大,无法一次导入(超过 5 MB)。', 'データが大きすぎて一度にインポートできません(5 MB 超)。', '데이터가 너무 커서 한 번에 가져올 수 없습니다(5MB 초과).'],
  errGeneric: ['失敗:{msg}', 'Failed: {msg}', '失败:{msg}', '失敗:{msg}', '실패: {msg}'],
  wNoScreenshots: ['匯入檔沒有截圖,畫面會沒有圖片。', 'The import has no screenshots; screens will have no image.', '导入文件没有截图,画面会没有图片。', 'インポートにスクリーンショットがないため、画面に画像がありません。', '가져올 파일에 스크린샷이 없어 화면에 이미지가 없습니다.'],
  wLimit: ['部分項目超過上限而未匯入({what})。', 'Some items exceeded a limit and were not imported ({what}).', '部分项目超过上限而未导入({what})。', '一部の項目が上限を超えたためインポートされませんでした({what})。', '일부 항목이 한도를 넘어 가져오지 않았습니다({what}).'],
  wTargetMerged: ['這個應用原有的部分畫面被認成同一個畫面。', 'Some of this app\'s existing screens were recognised as the same screen.', '这个应用原有的部分画面被认成同一个画面。', 'このアプリの既存の画面の一部が同じ画面と判断されました。', '이 앱의 기존 화면 일부가 같은 화면으로 인식되었습니다.'],
} satisfies Record<string, L5>;

const BODY_LIMIT = 5 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 依序執行,同時最多 n 個。 */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

export default function MemoryTransfer({ appId, lang, onImported }: { appId: string; lang: RLang; onImported?: () => void }) {
  const t = (k: keyof typeof T, vars?: Record<string, string | number>) => fill(pick5(T[k], lang), vars);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const explain = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === 'APP_HAS_RUNNING_JOBS') return t('errRunning');
      if (err.code === 'ALREADY_IMPORTED') return t('errAlready');
      if (err.code === 'MEMORY_CHANGED') return t('errChanged');
      return t('errGeneric', { msg: err.message });
    }
    if (err instanceof ZipError) return t('errZip', { code: err.code });
    return t('errGeneric', { msg: err instanceof Error ? err.message : String(err) });
  };

  async function onExport() {
    setBusy(true);
    setError('');
    setStatus(t('preparing'));
    try {
      const ex = await apiGet<ExportPayload>(`/memory/export?app=${encodeURIComponent(appId)}&lang=${encodeURIComponent(lang)}`);
      const text: Array<[string, string]> = [
        ['memory.md', ex.markdown],
        ['data/structure.json', JSON.stringify(ex.data.structure, null, 1)],
        ['data/edits.json', JSON.stringify(ex.data.edits, null, 1)],
        ['data/hints.json', JSON.stringify(ex.data.hints, null, 1)],
        ['data/meta.json', JSON.stringify(ex.data.meta, null, 1)],
      ];
      const files: ZipInput[] = [];
      const hashes: Record<string, { sha256: string; bytes: number }> = {};
      for (const [name, body] of text) {
        const bytes = enc.encode(body);
        files.push({ name, data: bytes });
        hashes[name] = { sha256: await sha256Hex(bytes), bytes: bytes.length };
      }
      let done = 0;
      let failed = 0;
      const shots: ZipInput[] = [];
      setStatus(t('downloading', { done, total: ex.screenshots.length }));
      await pool(ex.screenshots, 4, async (s) => {
        try {
          const res = await fetch(s.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          hashes[s.path] = { sha256: await sha256Hex(bytes), bytes: bytes.length };
          shots.push({ name: s.path, data: blob });
        } catch {
          failed++;
        }
        setStatus(t('downloading', { done: ++done, total: ex.screenshots.length }));
      });
      shots.sort((a, b) => a.name.localeCompare(b.name));
      const manifest = { ...ex.manifest, counts: { ...(ex.manifest['counts'] as object), screenshots: shots.length }, files: hashes };
      setStatus(t('zipping'));
      const zip = await writeZip([{ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 1)) }, ...files, ...shots]);
      download(zip, `memory-${appId}-${stamp()}.zip`);
      const pages = Number((ex.manifest['counts'] as { pages?: number })?.pages ?? 0);
      setStatus([t('exported', { pages, shots: shots.length }), failed ? t('shotFailed', { n: failed }) : ''].filter(Boolean).join(' '));
    } catch (err) {
      setStatus('');
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError('');
    setPending(null);
    setStatus(t('reading'));
    try {
      const map = rootedEntries(await readZip(file));
      const man = map.get('manifest.json');
      if (!man) throw new Error(t('errNotBundle'));
      const json = async (name: string): Promise<unknown> => {
        const e = map.get(name);
        return e ? JSON.parse(dec.decode(await extract(file, e))) : null;
      };
      const manifest = (await json('manifest.json')) as { format?: string; files?: Record<string, { sha256?: string }> } | null;
      if (!manifest || manifest.format !== 'playagent-memory') throw new Error(t('errNotBundle'));
      // 完整性:manifest 記了雜湊就逐一比對(含截圖);沒記就標示「未驗證」。
      const listed = Object.entries(manifest.files ?? {});
      let n = 0;
      for (const [name, info] of listed) {
        setStatus(t('verifying', { done: ++n, total: listed.length }));
        const e = map.get(name);
        if (!e || !info?.sha256 || (await sha256Hex(await extract(file, e))) !== info.sha256) throw new Error(t('errHash', { file: name }));
      }
      const shotIds = [...map.keys()]
        .map((k) => /^screenshots\/(page_[a-f0-9]{8,32})\.png$/.exec(k)?.[1])
        .filter((x): x is string => Boolean(x));
      const hintsDoc = (await json('data/hints.json')) as { hints?: unknown[] } | null;
      const body = {
        app: appId,
        manifest,
        structure: await json('data/structure.json'),
        edits: (await json('data/edits.json')) ?? {},
        hints: hintsDoc?.hints ?? [],
        screenshots: shotIds,
      };
      if (enc.encode(JSON.stringify(body)).length > BODY_LIMIT) throw new Error(t('errBody'));
      setStatus(t('previewing'));
      const { summary } = await apiPost<{ summary: ImportSummary }>('/memory/import/preview', body);
      setPending({ file, map, body, summary, unverified: listed.length === 0 });
      setStatus('');
    } catch (err) {
      setStatus('');
      setError(explain(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onConfirm() {
    if (!pending) return;
    setBusy(true);
    setError('');
    setStatus(t('applying'));
    try {
      const r = await apiPost<{ summary: ImportSummary; uploads: Array<{ from: string; to: string; url: string }> }>('/memory/import/apply', pending.body);
      let done = 0;
      let failed = 0;
      setStatus(t('uploading', { done, total: r.uploads.length }));
      await pool(r.uploads, 4, async (u) => {
        try {
          const e = pending.map.get(`screenshots/${u.from}.png`);
          if (!e) throw new Error('missing');
          const bytes = await extract(pending.file, e);
          const res = await fetch(u.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Blob([bytes as BlobPart], { type: 'image/png' }) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
          failed++;
        }
        setStatus(t('uploading', { done: ++done, total: r.uploads.length }));
      });
      setPending(null);
      setStatus([t('imported', { added: r.summary.pages.added, merged: r.summary.pages.merged }), failed ? t('uploadFailed', { n: failed }) : ''].filter(Boolean).join(' '));
      onImported?.();
    } catch (err) {
      setStatus('');
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  const s = pending?.summary;
  const LIMIT_ROW: Record<string, keyof typeof T> = { hintsLimit: 'rowHints', routesLimit: 'rowRoutes', opEditsLimit: 'rowEdges', manualPathsLimit: 'rowEdges' };
  const limits = [...new Set((s?.warnings ?? []).map((w) => LIMIT_ROW[w]).filter((k): k is keyof typeof T => Boolean(k)).map((k) => t(k)))];
  return (
    <div className="memxfer">
      <div className="memxfer__bar">
        <button type="button" className="memory__clear-btn memxfer__btn" onClick={onExport} disabled={busy} title={t('exportHint')}>
          {t('exportBtn')}
        </button>
        <button type="button" className="memory__clear-btn memxfer__btn" onClick={() => fileRef.current?.click()} disabled={busy} title={t('importHint')}>
          {t('importBtn')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          aria-label={t('importBtn')}
          onChange={(e) => void onPickFile(e.target.files?.[0])}
        />
      </div>
      {status && <p className="memxfer__status" role="status">{status}</p>}
      {error && <p className="memxfer__error" role="alert">{error}</p>}
      {s && (
        <section className="memxfer__preview" aria-labelledby="memxfer-title">
          <h3 id="memxfer-title" className="memxfer__title">{t('previewTitle')}</h3>
          <p className="memxfer__from">{t('from', { app: s.fromAppName ? `${s.fromAppName} (${s.fromApp})` : s.fromApp, at: s.exportedAt ?? '?' })}</p>
          <table className="memxfer__table">
            <tbody>
              <tr><th scope="row">{t('rowPages')}</th><td>{t('added', { n: s.pages.added })}</td><td>{t('merged', { n: s.pages.merged })}</td></tr>
              <tr><th scope="row">{t('rowEdges')}</th><td>{t('added', { n: s.edges.added })}</td><td>{t('merged', { n: s.edges.merged })}</td></tr>
              <tr><th scope="row">{t('rowHints')}</th><td>{t('added', { n: s.hints.added })}</td><td>{t('skipped', { n: s.hints.skipped })}</td></tr>
              <tr><th scope="row">{t('rowRoutes')}</th><td>{t('added', { n: s.routes.added })}</td><td>{t('skipped', { n: s.routes.skipped })}</td></tr>
            </tbody>
          </table>
          <p className="memxfer__note">{t('other', { renames: s.renames, ops: s.opEdits, deleted: s.deleted.pages + s.deleted.edges, shots: s.screenshots })}</p>
          <p className="memxfer__note">{t('rules')}</p>
          <p className="memxfer__note">{t('mdNote')}</p>
          {pending?.unverified && <p className="memxfer__warn">{t('unverified')}</p>}
          {s.warnings.includes('noScreenshots') && <p className="memxfer__warn">{t('wNoScreenshots')}</p>}
          {s.warnings.includes('targetPagesMerged') && <p className="memxfer__warn">{t('wTargetMerged')}</p>}
          {limits.length > 0 && <p className="memxfer__warn">{t('wLimit', { what: limits.join(', ') })}</p>}
          <div className="memxfer__actions">
            <button type="button" className="memxfer__confirm" onClick={onConfirm} disabled={busy}>{t('confirm')}</button>
            <button type="button" className="memory__clear-btn" onClick={() => setPending(null)} disabled={busy}>{t('cancel')}</button>
          </div>
        </section>
      )}
    </div>
  );
}
