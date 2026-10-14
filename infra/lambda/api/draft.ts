import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

/** 預設草擬模型(使用者未指定時):便宜、快、不需 tool-calling。 */
const DRAFT_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

const SYSTEM_PROMPT = `你是一個把「自然語言測試描述」轉成「測試案例 YAML」的助手。
規則:
- 只輸出 YAML,不要有任何額外說明或 markdown 圍欄。
- YAML 需含欄位: name(案例名), app(被測應用 id), task(要 AI 代理執行的自然語言任務描述), assertions(判斷成功的條件清單)。
- 絕不可寫入任何字面量密碼或密鑰;若流程需要登入,以 \${ENV_VAR} 佔位表示帳密。
- 保持精簡、可執行。`;

/** 有提供範本基礎 YAML 時的系統提示:以編修既有範本為主,而非從零產生。 */
const REFINE_SYSTEM_PROMPT = `你是一個「測試案例 YAML 編修」助手。使用者會給你一份「既有範本 YAML」(通常由記憶地圖的可達路徑自動生成)與一句「自然語言調整指令」。
規則:
- 以既有範本為基礎,依調整指令修改,產出更新後的完整 YAML。
- 只輸出 YAML,不要有任何額外說明或 markdown 圍欄。
- 保留範本原有的合理結構;沒被指令要求更動的部分盡量保留。
- YAML 需含欄位: name, app, task;可含 assertions(成功判斷條件清單)。
- 絕不可寫入任何字面量密碼或密鑰;需登入時以 \${ENV_VAR} 佔位。
- 保持精簡、可執行。`;

/**
 * 有結構化驗收標準時的系統提示:要求 AI 產生「有明確停止條件」的任務。
 * 關鍵:AI 不自己發明驗收項目,逐條對照使用者給的清單判定;全部判定完就停,不再漫無目的地探索。
 * `items:`/`note:` 由伺服器端逐字附加(見 appendStructuredBlocks),所以這裡要求模型不要輸出這兩個鍵。
 */
const ACCEPTANCE_SYSTEM_PROMPT = `你是一個把「測試需求 + 結構化驗收標準」轉成「測試案例 YAML」的助手。
使用者會給你:一段整體描述,以及一份編號的驗收標準清單,每一項含「測試目的 / 測試步驟 / 預期結果」(部分項目可能附有預期畫面)。
規則:
- 只輸出 YAML,不要有任何額外說明或 markdown 圍欄。
- 只輸出這些頂層鍵: name(案例名), app(被測應用 id), task(給 AI 代理的執行指示), assertions(成功條件清單)。
- 「絕對不要」輸出 items 或 note 這兩個鍵 —— 這兩個鍵由系統另外逐字附加,你輸出了會造成重複。
- task 必須明確要求代理「依序完成每一個編號驗收項目,逐項對照其預期結果判定通過或失敗」。
- task 結尾必須寫明停止條件:當所有編號項目都已判定(通過或失敗)即視為完成,不要再繼續探索或重複操作。
- 若某項附有預期畫面,task 要指示代理把當下畫面與該預期畫面比對後再判定。
- assertions 逐條對應驗收項目的預期結果,保持可明確判定(避免「正常」「正確」這類模糊字眼)。
- 絕不可寫入任何字面量密碼或密鑰;需登入時以 \${ENV_VAR} 佔位。
- 保持精簡、可執行。`;

export interface DraftDeps {
  bedrock: Pick<BedrockRuntimeClient, 'send'>;
}

/** 單一結構化測試項目(由前端表格填入,欄位對齊常見測試案例表)。 */
export interface DraftAcceptanceItem {
  /** 類別(例:中央畫面區)。 */
  category?: string;
  /** 項目 / 功能(例:神秘商人)。 */
  module?: string;
  purpose: string;
  steps: string[];
  expected: string;
  /** 截圖的 artifactId(選填);幫助 AI 理解此項畫面並對照判定。 */
  expectedImage?: string;
}

export interface DraftOptions {
  /** 草擬用模型(已含 us. 前綴的最終 id);未給用預設。 */
  model?: string;
  /** 結構化驗收標準;有值時走「精準」草擬流程並逐字附加 items。 */
  acceptance?: DraftAcceptanceItem[];
  /** 可收合的 Markdown 備註;逐字附加為 note 區塊。 */
  note?: string;
}

/** 單行純量:安全就直接寫,否則用 JSON 雙引號字串(合法 YAML)。 */
function yscalar(v: string): string {
  const s = v.replace(/\s*\n\s*/g, ' ').trim();
  const plainSafe =
    s !== '' &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`~]/.test(s) &&
    !/:\s|\s#|:$/.test(s) &&
    !/^(true|false|null|yes|no|on|off|~|[-+]?\d[\d_.eE+-]*)$/i.test(s);
  return plainSafe ? s : JSON.stringify(s);
}

/**
 * 把結構化驗收項目與備註逐字附加到 AI 產生的 YAML 之後。
 * 逐字保留(不經 AI 轉述),確保驗收標準精準不走樣;`items:` 供報告逐項判定、`note:` 供人閱讀。
 */
export function appendStructuredBlocks(
  aiYaml: string,
  acceptance?: DraftAcceptanceItem[],
  note?: string,
): string {
  const parts = [aiYaml.trimEnd()];
  if (acceptance && acceptance.length > 0) {
    const lines = ['items:'];
    acceptance.forEach((it, i) => {
      const title = it.module || it.purpose || `項目 ${i + 1}`;
      lines.push(`  - ref: ${yscalar(String(i + 1))}`);
      lines.push(`    title: ${yscalar(title)}`);
      if (it.purpose) lines.push(`    purpose: ${yscalar(it.purpose)}`);
      if (it.category) lines.push(`    category: ${yscalar(it.category)}`);
      if (it.module) lines.push(`    module: ${yscalar(it.module)}`);
      const steps = (it.steps ?? []).filter((s) => s && s.trim() !== '');
      if (steps.length) {
        lines.push('    steps:');
        for (const s of steps) lines.push(`      - ${yscalar(s)}`);
      }
      if (it.expected) lines.push(`    expected: ${yscalar(it.expected)}`);
      if (it.expectedImage) lines.push(`    expectedImage: ${yscalar(it.expectedImage)}`);
    });
    parts.push(lines.join('\n'));
  }
  if (note && note.trim() !== '') {
    const body = note
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => (l.trim() ? `  ${l}` : ''))
      .join('\n');
    parts.push(`note: |\n${body}`);
  }
  return `${parts.join('\n')}\n`;
}

/** 把結構化驗收清單描述成給模型看的編號文字。 */
function acceptanceToPrompt(acceptance: DraftAcceptanceItem[]): string {
  const lines: string[] = [];
  acceptance.forEach((it, i) => {
    const head = [it.category, it.module].filter(Boolean).join(' / ');
    lines.push(`${i + 1}. ${head ? head + ' — ' : ''}測試目的: ${it.purpose || '(未填)'}`);
    const steps = (it.steps ?? []).filter((s) => s && s.trim() !== '');
    if (steps.length) {
      lines.push('   測試步驟:');
      steps.forEach((s, j) => lines.push(`     ${j + 1}) ${s}`));
    }
    lines.push(`   預期結果: ${it.expected || '(未填)'}`);
    if (it.expectedImage) lines.push('   (本項附有參考截圖,請據此理解要測的畫面/元素,並在判定時對照當下畫面)');
  });
  return lines.join('\n');
}

/**
 * 呼叫 Bedrock 產出/編修案例 YAML 草稿。
 * - 未提供 baseYaml 也沒有 acceptance:從自然語言描述「產生」案例(原行為)。
 * - 提供 baseYaml:以既有範本為基礎,依自然語言指令「編修」。
 * - 提供 acceptance:走「精準」流程 —— AI 產生有明確停止條件的 task,再逐字附加結構化 items。
 */
export async function draftCaseYaml(
  deps: DraftDeps,
  description: string,
  appId: string,
  baseYaml?: string,
  opts?: DraftOptions,
): Promise<string> {
  const refining = typeof baseYaml === 'string' && baseYaml.trim() !== '';
  const acceptance = (opts?.acceptance ?? []).filter(
    (it) => it && (it.purpose || it.expected || (it.steps ?? []).some((s) => s && s.trim())),
  );
  const structured = acceptance.length > 0;

  let system: string;
  let userContent: string;
  if (refining) {
    system = REFINE_SYSTEM_PROMPT;
    userContent = `被測應用 id: ${appId}\n既有範本 YAML:\n${baseYaml!.trim()}\n\n自然語言調整指令:\n${description || '(未給明確指令,請潤飾為更清楚可執行的測試案例)'}`;
  } else if (structured) {
    system = ACCEPTANCE_SYSTEM_PROMPT;
    userContent = `被測應用 id: ${appId}\n整體描述:\n${description || '(未提供整體描述,請依驗收標準產生)'}\n\n驗收標準(逐項對照判定,全部判定完即停止):\n${acceptanceToPrompt(acceptance)}`;
  } else {
    system = SYSTEM_PROMPT;
    userContent = `被測應用 id: ${appId}\n自然語言測試描述:\n${description}`;
  }

  // 前端傳回的已是 /models 清單上的最終可呼叫 id(含必要前綴);未指定則用預設。
  const modelId = opts?.model && opts.model.trim() !== ''
    ? opts.model.trim()
    : DRAFT_MODEL_ID;

  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: userContent }],
  };
  const res = await deps.bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  const text = new TextDecoder().decode(res.body as Uint8Array);
  const parsed = JSON.parse(text) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const raw = parsed.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';
  // 去除模型偶爾加上的 ``` 圍欄
  const yaml = raw.replace(/^```(?:ya?ml)?\n?/, '').replace(/\n?```$/, '').trim();
  // 結構化流程:把驗收項目與備註逐字附加,確保精準不走樣。
  return structured ? appendStructuredBlocks(yaml, acceptance, opts?.note) : yaml;
}

export function makeBedrockClient(region: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({ region });
}
