#!/usr/bin/env node
/**
 * 使用說明書的截圖擷取器 —— 從實際部署的後端抓每一頁的畫面,五種語系各一套。
 *
 * 為什麼是「真的跑一次」而不是假資料:說明書的圖如果來自 mock,讀者照著做會看到不一樣的
 * 畫面。所以這支腳本建一個短命的 Cognito 使用者、在隔離租戶 `demo` 裡用合成名稱建應用與
 * 案例、送一次真的 web 測試,然後在任務「執行中」與「已結束」兩個時點各抓一輪 —— 有三個
 * 畫面只在執行中存在,有三個只在結束後存在。同一個應用、同一個案例、同一次執行,
 * 用五個瀏覽器 context(localStorage `playagent.locale` 不同)各拍一套。
 *
 * 這個 repo 是公開的,截圖進了歷史就purge不掉,所以:
 *   - 所有資料都在 `demo` 租戶;
 *   - 登入前先解 id token 的 custom:tenantId,不是 demo 就中止(絕不對 default 租戶截圖);
 *   - 臨時使用者的密碼用 crypto.randomBytes 產生、只存在記憶體裡,不進 argv、不進 env、
 *     不進檔案、不進 log;
 *   - 跨租戶的頁面(成員 / 知識庫 / 真機與容器 / 集中日誌)先縮小範圍再截。
 *
 * 語言一致性:每張圖拍之前,先對畫面上的 DOM 文字跑 lib/language-check.mjs
 * (資料區塊先遮掉);有違規就在最後以非零狀態結束,並列出語系、檔名與字元。
 * 檢查對象是 DOM 文字,不是像素:圖片裡的內容(遊戲畫面)檢查不到。
 *
 * 安裝與用法(這個資料夾不在根目錄的 workspaces 裡,部署路徑不會解析它):
 *   npm ci --prefix tools/screenshots
 *   npx --prefix tools/screenshots playwright install chromium
 *   node tools/screenshots/capture.mjs              擷取(建使用者 → 建資料 → 跑測試 → 五語系截圖)
 *   node tools/screenshots/capture.mjs --teardown   清掉 demo 租戶的資料與臨時使用者
 *   node tools/screenshots/capture.mjs --selftest   只驗證語言檢查會抓得到違規(不連網)
 *
 * 可用環境變數覆寫:PA_SITE_URL / PA_REGION / PA_STACK_PREFIX / PA_TENANT / PA_USER_EMAIL。
 * PA_SITE_URL 預設是線上站台;要拍尚未部署的 UI,先本機 build 再 `vite preview`,
 * 把 PA_SITE_URL 指向 http://localhost:4173。
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_REGIONS, LOCALES, checkCollected, collectDomText, selftest } from './lib/language-check.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = join(repoRoot, 'docs', 'screenshots');

const LIVE_SITE = 'https://d2sd3fmuly1j9g.cloudfront.net';
const SITE = (process.env.PA_SITE_URL ?? LIVE_SITE).replace(/\/$/, '');
const REGION = process.env.PA_REGION ?? 'us-west-2';
const STACK_PREFIX = process.env.PA_STACK_PREFIX ?? 'PlayAgentDev';
const TENANT = process.env.PA_TENANT ?? 'demo';
const USER_EMAIL = process.env.PA_USER_EMAIL ?? 'qa-demo@example.com';
const ADMIN_GROUP = 'admins';

/** 被測的遊戲:說明書要求明列網址;web 應用的目標網址就是它。 */
const GAME_NAME = 'Slotomania (web demo)';
const GAME_URL = 'https://play.slotomania.com/slots/';
const MOBILE_NAME = 'Example Slots Mobile';
const GAME_GENRE = 'slot';
const STEP_CAP = '25';
const BUDGET_CAP = '1';

/** 只有這些名字的應用可以被 --teardown 刪掉(絕不碰不是這支腳本建的東西)。 */
const SEEDED_APP_NAMES = ['Example Slots', MOBILE_NAME, GAME_NAME];

/** 任務的終止狀態(對齊 AppWorkspacePage.tsx 的 TERMINAL)。 */
const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);

/** 語系 id → Playwright 的瀏覽器 locale。 */
const BROWSER_LOCALE = { 'zh-Hant': 'zh-TW', en: 'en-US', 'zh-Hans': 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' };

/**
 * 任務詳情頁右側分頁的順序(對齊 TaskDetailPage.tsx 的 RIGHT_TABS_LANDSCAPE / PORTRAIT,
 * 直向只是在最後多一個 agent,前 7 個索引不變)。標籤文字會隨語系改變,所以用索引。
 */
const PANE = { moment: 0, logs: 1, trace: 2, analysis: 3, usage: 4, ask: 5, script: 6 };

const VIEWPORT = { width: 1280, height: 800 };
/** 等任務結束的上限。 */
const RUN_TIMEOUT_MS = 20 * 60_000;

const log = (...a) => console.log(...a);

// ───────────────────────────── 工具 ─────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 依賴(playwright / Cognito SDK)延遲載入,讓 --selftest 在沒裝依賴時也能跑。 */
async function loadDeps() {
  const sdk = await import('@aws-sdk/client-cognito-identity-provider');
  const { chromium } = await import('playwright');
  return { sdk, chromium };
}

/** 呼叫 AWS CLI 取唯讀資訊。AWS_PAGER 要清掉,否則 CLI v2 會卡在分頁器等輸入。 */
function awsJson(args) {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json', '--no-cli-pager'], {
    encoding: 'utf8',
    env: { ...process.env, AWS_PAGER: '' },
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * 產生 24 碼密碼(大寫 + 小寫 + 數字)。
 * 池的密碼政策是 8 碼以上、需含三類、不要求符號(infra/lib/constructs/cognito-tenant-pool.ts),
 * 所以不用符號就夠 —— 符號還要擔心被 shell 吃掉。這個值只存在記憶體裡。
 */
function generatePassword() {
  const UP = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LO = 'abcdefghijkmnopqrstuvwxyz';
  const NU = '23456789';
  const all = UP + LO + NU;
  const pickFrom = (set) => {
    // 拒絕取樣:避免 % 造成的分佈偏斜。
    for (;;) {
      const b = randomBytes(1)[0];
      if (b < 256 - (256 % set.length)) return set[b % set.length];
    }
  };
  const chars = [pickFrom(UP), pickFrom(LO), pickFrom(NU)];
  while (chars.length < 24) chars.push(pickFrom(all));
  // Fisher-Yates(亂數同樣來自 randomBytes),讓前三碼不固定是大/小/數字。
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** 僅供顯示地解碼 id token(與 web/src/auth/cognitoClient.ts 的 decodeIdToken 同一套)。 */
function decodeIdToken(idToken) {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('id token 格式不正確');
  const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  const groups = json['cognito:groups'];
  return {
    email: typeof json.email === 'string' ? json.email : null,
    tenantId: typeof json['custom:tenantId'] === 'string' ? json['custom:tenantId'] : null,
    isAdmin: Array.isArray(groups) && groups.includes(ADMIN_GROUP),
  };
}

/** 從前端原始碼讀遊戲類型清單(IconSelect 的選項順序),不依賴會隨語系變動的標籤文字。 */
function genreIndex(genre) {
  const src = readFileSync(join(repoRoot, 'web', 'src', 'components', 'GenreIcon.tsx'), 'utf8');
  const body = /export const GENRES = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
  const list = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const i = list.indexOf(genre);
  if (i < 0) throw new Error(`GenreIcon.tsx 的 GENRES 裡找不到 ${genre}`);
  return i;
}

// ────────────────────────── 設定探索(唯讀)──────────────────────────

/**
 * 從 CloudFormation 輸出讀 pool / client / API —— 和 scripts/deploy-latest.mjs 同一個來源,
 * 不把任何 id 寫死在這支腳本裡。
 */
function discoverConfig() {
  const outputsOf = (stack) => {
    const res = awsJson(['cloudformation', 'describe-stacks', '--stack-name', `${STACK_PREFIX}-${stack}`]);
    return res.Stacks?.[0]?.Outputs ?? [];
  };
  const pick = (outs, prefix) => outs.find((o) => (o.OutputKey ?? '').startsWith(prefix))?.OutputValue;
  const exact = (outs, key) => outs.find((o) => o.OutputKey === key)?.OutputValue;

  const foundation = outputsOf('Foundation');
  const userPoolId = pick(foundation, 'AuthUserPoolId');
  const clientId = pick(foundation, 'AuthUserPoolClientId');
  const controlPlane = outputsOf('ControlPlane');
  const apiUrl = exact(controlPlane, 'ApiUrl');

  if (!userPoolId || !clientId || !apiUrl) {
    throw new Error(`${STACK_PREFIX} 堆疊輸出缺少 pool / client / ApiUrl`);
  }

  // 交叉檢查:這個 client 真的屬於這個 pool(避免拿到別的環境的輸出)。
  const clients = awsJson(['cognito-idp', 'list-user-pool-clients', '--user-pool-id', userPoolId]);
  if (!(clients.UserPoolClients ?? []).some((c) => c.ClientId === clientId)) {
    throw new Error(`app client ${clientId} 不屬於使用者池 ${userPoolId}`);
  }

  return { userPoolId, clientId, apiUrl: apiUrl.replace(/\/$/, '') };
}

/** 目標站台若和線上站台的 /assets/ 雜湊相同,代表拍到的是舊的 UI(沒有用本機 build)。 */
async function warnIfStaleTarget() {
  if (SITE === LIVE_SITE) {
    log('   注意:目標是線上站台,畫面是已部署的版本(尚未部署的修正不會出現)');
    return;
  }
  const hashOf = async (base) => {
    try {
      const html = await (await fetch(`${base}/`)).text();
      return /\/assets\/(index-[\w-]+\.js)/.exec(html)?.[1] ?? null;
    } catch {
      return null;
    }
  };
  const [mine, live] = await Promise.all([hashOf(SITE), hashOf(LIVE_SITE)]);
  if (mine && live && mine === live) {
    console.warn(`警告:${SITE} 的 /assets/ 雜湊(${mine})和線上站台相同,可能拍到的是舊版 UI。`);
  }
}

// ────────────────────────── 臨時使用者 ──────────────────────────

/**
 * 建臨時使用者:custom:tenantId 在池裡是 mutable:false,所以一定要在 AdminCreateUser
 * 當下就設好,事後改不了。加入 admins 群組必須在登入之前 —— cognito:groups 是寫進
 * id token 的,之後才加要重新登入才看得到管理頁。
 */
async function ensureTempUser(sdk, cognito, userPoolId) {
  const password = generatePassword();
  let existed = true;
  try {
    await cognito.send(new sdk.AdminGetUserCommand({ UserPoolId: userPoolId, Username: USER_EMAIL }));
  } catch (err) {
    if (err?.name !== 'UserNotFoundException') throw err;
    existed = false;
  }

  if (!existed) {
    await cognito.send(
      new sdk.AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: USER_EMAIL,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: USER_EMAIL },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'custom:tenantId', Value: TENANT },
        ],
      }),
    );
    log(`  建立臨時使用者 ${USER_EMAIL}(租戶 ${TENANT})`);
  } else {
    log(`  臨時使用者 ${USER_EMAIL} 已存在,重設密碼`);
  }

  await cognito.send(
    new sdk.AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: USER_EMAIL,
      Password: password,
      Permanent: true,
    }),
  );
  await cognito.send(
    new sdk.AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: USER_EMAIL,
      GroupName: ADMIN_GROUP,
    }),
  );
  return password;
}

/** USER_PASSWORD_AUTH 登入(app client 沒有 secret,與前端走同一條路)。 */
async function signIn(sdk, cognito, clientId, password) {
  const res = await cognito.send(
    new sdk.InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: USER_EMAIL, PASSWORD: password },
    }),
  );
  const r = res.AuthenticationResult;
  if (!r?.IdToken || !r.AccessToken) throw new Error(`登入未取得 token(challenge: ${res.ChallengeName ?? '-'})`);
  return {
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken ?? '',
    expiresAt: Date.now() + (r.ExpiresIn ?? 3600) * 1000,
    signedInAt: Date.now(),
  };
}

// ────────────────────────── 控制面 API ──────────────────────────

/** 建一個只讀控制面的小 client;token 快到期時自己換新(長任務會跑超過一小時)。 */
function makeApi(sdk, cognito, clientId, apiUrl, tokens) {
  const state = { tokens };
  const fresh = async () => {
    if (state.tokens.expiresAt - Date.now() > 5 * 60_000 || !state.tokens.refreshToken) return state.tokens;
    const res = await cognito.send(
      new sdk.InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: state.tokens.refreshToken },
      }),
    );
    const r = res.AuthenticationResult;
    if (r?.IdToken && r.AccessToken) {
      state.tokens = {
        ...state.tokens,
        idToken: r.IdToken,
        accessToken: r.AccessToken,
        expiresAt: Date.now() + (r.ExpiresIn ?? 3600) * 1000,
      };
    }
    return state.tokens;
  };
  const call = async (method, path, body) => {
    const t = await fresh();
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t.idToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    get: (p) => call('GET', p),
    del: (p) => call('DELETE', p),
    // 每次新開 context 前呼叫,拿到最新的 token(必要時先換新)。
    freshTokens: fresh,
  };
}

// ────────────────────────── 截圖 ──────────────────────────

/**
 * 每個語系一個 shooter:輸出到 docs/screenshots/<locale>/NN-slug.png。
 * 每張圖拍之前先對 DOM 文字跑語言檢查;違規只記錄,最後一起以非零狀態結束。
 */
function makeShooter(locale, violations, { dryRun = false } = {}) {
  const dir = join(OUT_ROOT, locale);
  if (!dryRun) mkdirSync(dir, { recursive: true });
  const manifest = [];
  let n = 0;
  /**
   * 寫一張圖。target 可以是 page(整個視窗)或 locator(只截那一塊)。
   * 編號只在成功後才前進,所以檔名永遠連號。
   */
  const shot = async (target, slug, label, route, opts = {}) => {
    const file = `${String(n + 1).padStart(2, '0')}-${slug}.png`;
    const page = typeof target.page === 'function' ? target.page() : target;
    const collected = await page.evaluate(collectDomText, DATA_REGIONS);
    const res = checkCollected(locale, collected);
    log(`  [${locale}/${file}] ${label}  (遮掉資料字元 ${res.maskedChars})`);
    if (!res.ok) {
      const chars = res.violations.map((v) => `${v.char}(${v.kind})`).join(' ');
      violations.push({ locale, file, slug, chars });
      console.error(`  ✗ 語言檢查失敗 ${locale}/${file}:${chars}`);
      for (const s of res.sources ?? []) console.error(`      來源 ${s}`);
    }
    // 整頁截圖前先回到頂端:頂欄是 sticky 的,頁面捲過之後拍整頁會讓它卡在畫面中間。
    if (opts.fullPage && typeof target.evaluate === 'function') {
      await target.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await sleep(250);
    }
    await target.screenshot({ path: join(dir, file), ...opts });
    n += 1;
    manifest.push({ file, slug, route, label, maskedChars: res.maskedChars });
    return file;
  };
  return { shot, manifest };
}

/** 等畫面安定:先等網路閒置(輪詢頁面等不到就算了),再給 CSS 轉場一點時間。 */
async function settle(page, ms = 700) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(ms);
}

/** 換 hash 路由(HashRouter);同頁切換不會重載,所以不用 goto。 */
async function nav(page, hash, ms) {
  await page.evaluate((h) => {
    window.location.hash = h;
    window.scrollTo(0, 0);
  }, hash);
  await settle(page, ms);
}

/**
 * 切到任務詳情頁右側的某個分頁(用 PANE 的索引,不用會翻譯的標籤文字)。
 *
 * TaskDetailPage 同時渲染三組 .dstage__tabs(手機畫面下方的「與畫面互動」、右側對話欄、
 * 中間事件欄),其中兩組會被 hidden,而且只有右側那組有 7 個以上的分頁,
 * 所以先挑出「看得見、且至少有第 7 個分頁」的那一組,再用索引點。
 */
async function openPane(page, index) {
  const bar = page.locator('.dstage__tabs:visible').filter({ has: page.locator('.dstage__tab:nth-child(7)') }).first();
  if (!(await bar.count())) throw new Error('找不到任務詳情頁右側的分頁列(.dstage__tabs 至少 7 個分頁)');
  await bar.locator('.dstage__tab').nth(index).click();
  await settle(page, 1200);
}

/**
 * 在某個 AI 問答面板裡問一句話,等答案真的回來;答不回來就失敗,不拍空面板。
 *
 * 不能只等「忙碌中」的列消失:剛送出時那一列還沒掛上,條件立刻為真,就會拍到一個空面板。
 * 所以先等自己的那句話出現,再等至少一則非忙碌的回覆,最後確認一問一答都在。
 */
async function ask(page, scope, question) {
  const box = page.locator(`${scope}__form textarea`).first();
  if (!(await box.count())) throw new Error(`找不到問答輸入框 ${scope}__form textarea`);
  await box.fill(question);
  await box.press('Enter');
  await page.waitForSelector(`${scope}__msg--user`, { timeout: 30_000 });
  await page.waitForFunction(
    (sel) => {
      const msgs = [...document.querySelectorAll(`${sel}__msg--assistant`)];
      return msgs.some((el) => !el.classList.contains('taskask__msg--busy'));
    },
    scope,
    { timeout: 180_000 },
  );
  await settle(page, 1500);
  const users = await page.locator(`${scope}__msg--user`).count();
  const answers = await page.locator(`${scope}__msg--assistant:not(.taskask__msg--busy)`).count();
  if (users < 1 || answers < 1) throw new Error(`問答不完整:user=${users} assistant=${answers}(${scope})`);
}

/** 捲到報告的某一節(錨點由 StructuredReportView 的 id=`srep-<section>` 產生)。 */
async function scrollToId(page, id) {
  const ok = await page.evaluate((x) => {
    const el = document.getElementById(x);
    if (!el) return false;
    el.scrollIntoView({ block: 'start' });
    return true;
  }, id);
  await sleep(500);
  return ok;
}

// ────────────────────────── 種資料(走 UI)──────────────────────────

/**
 * 建應用。刻意走畫面而不是打 API:建立表單本身就是說明書要的一張圖,
 * 用 API 建出來的資料配上手動擺出來的空表單,等於圖和流程對不起來。
 * 應用已存在時(後面幾個語系、或重跑)只填表單、拍圖、取消。
 */
async function createApp(page, { name, platform, identifier, shooter, formSlug }) {
  await nav(page, '/apps');
  const exists = (await page.locator('.apps__card-name', { hasText: name }).count()) > 0;

  await page.click('.apps__create-btn');
  await page.waitForSelector('.apps__form');
  const grid = page.locator('.apps__form-grid');
  await grid.locator('.apps__field').first().locator('input').fill(name);
  await grid.locator('select').first().selectOption(platform);
  // 遊戲類型是自繪的 listbox(原生 option 塞不進 SVG),所以要點開再依索引選
  // (索引來自前端的 GENRES 清單順序;標籤文字會隨語系翻譯,不能拿來比對)。
  await grid.locator('.iconselect__button').first().click();
  await page.locator('.iconselect__option').nth(genreIndex(GAME_GENRE)).click();
  // 識別碼欄位是平台相依的最後一欄:web 是「測試網址」(type=url),
  // android/ios 是套件名稱。兩種都是表單格線裡最後一個有 input 的欄位。
  await grid.locator('.apps__field:has(input)').last().locator('input').fill(identifier);
  await settle(page, 400);
  if (formSlug) {
    await shooter.shot(page, formSlug, `新增應用表單(${name})`, '#/apps');
  }
  if (exists) {
    await page.click('.apps__cancel');
    await page.waitForSelector('.apps__form', { state: 'detached', timeout: 30_000 });
    await settle(page);
    return;
  }
  await page.click('.apps__submit');
  await page.waitForSelector('.apps__form', { state: 'detached', timeout: 30_000 });
  await settle(page);
  log(`  建立應用「${name}」`);
}

/**
 * 這一份 YAML 刻意不含任何像密鑰的鍵:cases.ts 的 assertNoLiteralSecrets 會擋字面量密鑰。
 * 任務寫得很窄(兩條驗收 + 明確的停止條件),不登入、不購買,只看大廳載入並停下來。
 */
const CASE_YAML = `url: ${GAME_URL}
task: |
  Open the page and wait for the slot game lobby to load. Confirm that game
  tiles or a play button are visible. Do not sign in and do not purchase
  anything. Stop after confirming the lobby.
acceptance:
  - category: Lobby
    module: Page load
    purpose: The slot game page finishes loading
    steps:
      - Open the start URL
    expected: The page renders game content without an error screen
  - category: Lobby
    module: Game entry
    purpose: A way to start playing is visible
    steps:
      - Look for a play button or a game tile
    expected: At least one play button or game tile is visible
`;

/** 在應用工作區裡用 YAML 模式建案例(YAML 模式不呼叫 Bedrock,結果可重現)。 */
async function createCase(page, appId, caseName, shooter) {
  await nav(page, `/apps/${encodeURIComponent(appId)}?tab=cases`);
  const exists = (await page.locator('table', { hasText: caseName }).count()) > 0;
  await page.click('.cases__create-btn');
  await page.waitForSelector('.cases__form');
  await page.locator('.cases__field--grow input').fill(caseName);
  await settle(page, 400);

  // 自然語言模式(預設)+ 結構化驗收編輯器:說明書要先介紹「白話描述 → AI 草擬」這條路。
  await page.locator('.cases__textarea').first().fill(
    'Open the slot game page, wait for the lobby to load, and confirm that a play button or game tile is visible.',
  );
  await settle(page, 400);
  await shooter.shot(page, 'case-form-nl', '測試案例:自然語言描述模式', '#/apps/:appId?tab=cases');
  const acceptance = page.locator('.cases__form .acc').first();
  if (await acceptance.count()) {
    // 「帶入範例」(.acc__btn--ghost)填入該語系的範例列,空表格截出來看不出這個編輯器在做什麼。
    const insert = acceptance.locator('.acc__table-actions .acc__btn--ghost');
    if (await insert.count()) {
      await insert.first().click();
      await settle(page, 500);
    }
    await acceptance.scrollIntoViewIfNeeded();
    await sleep(300);
    await shooter.shot(acceptance, 'case-form-acceptance', '測試案例:結構化驗收標準編輯器', '#/apps/:appId?tab=cases');
  }

  // YAML 模式:直接存,不經草擬。
  await page.locator('.cases__tab').nth(1).click();
  await page.waitForSelector('.cases__textarea--mono');
  await page.locator('.cases__textarea--mono').fill(CASE_YAML);
  await settle(page, 400);
  // fill 之後插入點在最後一行,textarea 自己也捲到底:捲回頂端,圖裡才看得到 url: 與 task:。
  await page.evaluate(() => {
    const el = document.querySelector('.cases__textarea--mono');
    if (el) el.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await sleep(300);
  await shooter.shot(page, 'case-form-yaml', '測試案例:YAML 模式', '#/apps/:appId?tab=cases');

  // Excel 匯入分頁(只有新建時才有)。
  const excelTab = page.locator('.cases__tab').nth(2);
  if (await excelTab.count()) {
    await excelTab.click();
    await settle(page, 500);
    await shooter.shot(page, 'case-form-excel', '測試案例:從 Excel 匯入', '#/apps/:appId?tab=cases');
    await page.locator('.cases__tab').nth(1).click();
    await page.waitForSelector('.cases__textarea--mono');
    await settle(page, 300);
  }

  if (exists) {
    await page.click('.cases__cancel');
    await page.waitForSelector('.cases__form', { state: 'detached', timeout: 30_000 });
    await settle(page);
    return;
  }
  await page.click('.cases__submit');
  await page.waitForSelector('.cases__form', { state: 'detached', timeout: 30_000 });
  await settle(page);
  log(`  建立案例「${caseName}」`);
}

/**
 * (弱點 a)把該遊戲類型的內建知識庫存成這個應用的預設知識庫。
 * 提交表單只會預選「應用已存的預設知識庫」,新建的應用沒有,所以要先到知識分頁勾選並儲存。
 * 已經勾好就不動(不會把它關掉);第二個語系起是 no-op。
 */
async function seedDefaultKnowledge(page, api, appId) {
  const kbs = ((await api.get('/knowledge-bases')).items ?? []).filter((k) => !k.archived);
  const idx = kbs.findIndex((k) => k.id === `kb-builtin-${GAME_GENRE}`);
  if (idx < 0) throw new Error(`知識庫清單裡找不到 kb-builtin-${GAME_GENRE},無法預選知識庫`);
  await nav(page, `/apps/${encodeURIComponent(appId)}?tab=knowledge`, 1000);
  const boxes = page.locator('.ws__kb-list input[type="checkbox"]');
  await boxes.nth(0).waitFor({ timeout: 30_000 });
  if ((await boxes.count()) !== kbs.length) {
    throw new Error(`知識分頁的勾選框數量(${await boxes.count()})和 API 的知識庫數量(${kbs.length})不一致`);
  }
  const box = boxes.nth(idx);
  if (await box.isChecked()) return;
  await box.check();
  await page.locator('.ws__kb-actions .ws__primary').click();
  await page.waitForSelector('.ws__muted[role="status"]', { timeout: 30_000 });
  await settle(page, 500);
  log(`  已把 kb-builtin-${GAME_GENRE} 存成「${GAME_NAME}」的預設知識庫`);
}

/** 開提交表單並填好:案例、步數與預算上限。回傳之前先確認預選的知識庫至少 1 個(弱點 a)。 */
async function fillSubmitForm(page, caseName, hideCustomKbs) {
  await page.locator('.tasks__submit-btn').first().click();
  await page.waitForSelector('.tasks__form');
  // 案例下拉選我們剛建的那一筆;執行環境留平台預設(web → Web browser),模型留三個預設席位。
  const caseSelect = page.locator('.tasks__form select').first();
  await caseSelect.selectOption({ label: caseName });
  await settle(page, 800);
  // 上限:步數與預算都設小一點,把這次示範的花費框住。
  await page.locator('.tform__adv > summary').click();
  await page.locator('.tform__adv input[type="number"]').nth(0).fill(STEP_CAP);
  await page.locator('.tform__adv input[type="number"]').nth(1).fill(BUDGET_CAP);
  await settle(page, 500);
  await hideCustomKbs();
  const chosen = await page.locator('.tform__chip.is-on').count();
  if (chosen < 1) throw new Error('提交表單沒有預選任何知識庫(0 個):應用的預設知識庫沒有存成功');
}

// ────────────────────────── 每個語系的各階段 ──────────────────────────

/** 開一個已登入、指定語系的瀏覽器 context。 */
async function openSession(browser, api, locale, { anonymous = false } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: BROWSER_LOCALE[locale] });
  const auth = anonymous ? null : JSON.stringify(await api.freshTokens());
  await context.addInitScript(
    ([loc, a]) => {
      window.localStorage.setItem('playagent.locale', loc);
      if (a) window.localStorage.setItem('playagent.auth', a);
    },
    [locale, auth],
  );
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return { context, page };
}

/** 截圖前把跨租戶共用的非內建知識庫列藏起來(它們可能用真實遊戲名命名)。 */
function makeHideCustomKbs(page, customKbNames) {
  return async () => {
    if (customKbNames.length === 0) return;
    await page.evaluate((names) => {
      const rows = document.querySelectorAll('.ws__kb-list li, .tform__chip, .apps__kb-option, .kb__card');
      for (const el of rows) {
        const txt = (el.textContent ?? '').trim();
        if (names.some((n) => txt.includes(n))) el.style.display = 'none';
      }
    }, customKbNames);
    await sleep(250);
  };
}

/** 階段 1:送出前的所有畫面(登入頁、指南、種資料、各分頁、提交表單)。 */
async function phasePreRun(browser, api, locale, shooter, ctx) {
  const wsRoute = '#/apps/:appId';
  log(`\n【${locale}】送出前的畫面`);

  {
    const anon = await openSession(browser, api, locale, { anonymous: true });
    await anon.page.goto(`${SITE}/#/guide`, { waitUntil: 'domcontentloaded' });
    await anon.page.waitForSelector('.login__card');
    await settle(anon.page);
    await shooter.shot(anon.page, 'login', '登入頁(欄位尚未填寫)', '#/');
    await anon.context.close();
  }

  const { context, page } = await openSession(browser, api, locale);
  await page.goto(`${SITE}/#/guide`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 30_000 });
  await settle(page, 1200);
  await shooter.shot(page, 'guide', '使用指南(14 個章節)', '#/guide', { fullPage: true });

  await createApp(page, {
    name: GAME_NAME,
    platform: 'web',
    identifier: GAME_URL,
    shooter,
    formSlug: 'apps-create-form',
  });
  await createApp(page, {
    name: MOBILE_NAME,
    platform: 'android',
    identifier: 'com.example.slotsgame',
    shooter: null,
  });

  const apps = (await api.get('/apps')).items ?? [];
  const webApp = apps.find((a) => a.name === GAME_NAME);
  const mobileApp = apps.find((a) => a.name === MOBILE_NAME);
  if (!webApp) throw new Error(`建立後找不到 ${GAME_NAME}`);
  ctx.webAppId = webApp.id;
  ctx.appIds = [webApp, mobileApp].filter(Boolean).map((a) => `${a.name}=${a.id}`);

  await nav(page, '/apps');
  await settle(page, 900);
  await shooter.shot(page, 'apps', '應用管理(卡片牆)', '#/apps', { fullPage: true });

  await createCase(page, webApp.id, ctx.caseName, shooter);

  // 知識庫是跨租戶共用資源(listKnowledgeBases 讀 shared/):別的租戶自建的那幾座
  // 會用真實的遊戲名字命名,不能出現在公開截圖裡。先問 API 哪幾座不是內建的,
  // 之後每次要截到知識庫清單前先把那幾列藏掉。
  const customKbNames = ((await api.get('/knowledge-bases')).items ?? [])
    .filter((kb) => !kb.builtin)
    .map((kb) => String(kb.name ?? '').trim())
    .filter(Boolean);
  const hideCustomKbs = makeHideCustomKbs(page, customKbNames);
  ctx.customKbNames = customKbNames;

  await seedDefaultKnowledge(page, api, webApp.id);

  await nav(page, `/apps/${encodeURIComponent(webApp.id)}`, 1000);
  await shooter.shot(page, 'workspace-overview', '應用工作區:總覽', wsRoute, { fullPage: true });
  for (const [tab, slug, label] of [
    ['builds', 'workspace-builds', '應用工作區:版本'],
    ['cases', 'workspace-cases', '應用工作區:測試案例'],
    ['knowledge', 'workspace-knowledge', '應用工作區:知識綁定'],
    ['credentials', 'workspace-credentials', '應用工作區:測試憑證'],
  ]) {
    await nav(page, `/apps/${encodeURIComponent(webApp.id)}?tab=${tab}`, 1000);
    if (tab === 'knowledge') await hideCustomKbs();
    await shooter.shot(page, slug, label, `${wsRoute}?tab=${tab}`, { fullPage: true });
  }

  await nav(page, '/cases', 1000);
  await shooter.shot(page, 'cases', '測試案例總覽(全部應用)', '#/cases', { fullPage: true });

  await nav(page, '/knowledge', 1200);
  // 「我的知識庫」讀的是跨租戶共用的 shared/,只截內建範本分頁。
  await page.locator('.kb__tab').first().click();
  await settle(page, 700);
  await shooter.shot(page, 'knowledge-templates', '知識庫:內建範本', '#/knowledge', { fullPage: true });

  await nav(page, '/devices', 1500);
  // /devices/infra 是整個帳號範圍的:容器 / 主機 / 串流的列表可能含別的租戶的任務 id,
  // 所以只留區塊說明與狀態,把那三張卡的列表隱藏起來再截。
  await page.addStyleTag({
    content:
      '.devices__card:nth-of-type(2) .devices__cloud-list,' +
      '.devices__card:nth-of-type(3) .devices__cloud-list,' +
      '.devices__card:nth-of-type(4) .devices__cloud-list{display:none!important}',
  });
  await settle(page, 600);
  await shooter.shot(page, 'devices', '真機與容器(帳號範圍的列表已隱藏)', '#/devices', { fullPage: true });

  await nav(page, '/cost', 1500);
  await page.locator('.cost__tab').first().click();
  await settle(page, 800);
  await shooter.shot(page, 'cost', '成本分析:測試花費', '#/cost', { fullPage: true });

  await nav(page, '/members', 1500);
  // 成員清單是跨租戶的:先用臨時信箱過濾,畫面上只會剩這一列。
  await page.locator('.members__search').fill(USER_EMAIL);
  await settle(page, 600);
  await shooter.shot(page, 'members', `成員管理(已過濾為 ${USER_EMAIL})`, '#/members');
  await page.locator('.members__add-btn').first().click();
  await page.waitForSelector('.members__form');
  // 表單一打開就先產生一組初始密碼並明文顯示。那串字沒有被用來建任何帳號,但「畫面上
  // 看得到的密碼」不能進公開的截圖,所以清空讓它只顯示 placeholder。
  await page.locator('.members__field--pw input').fill('');
  await settle(page, 500);
  await shooter.shot(page, 'members-add', '成員管理:新增成員表單(密碼欄未填)', '#/members');

  await nav(page, '/model-admin', 1500);
  // 模型設定是整個平台共用的(不分租戶),所以「上次儲存」那一行會印出平台擁有者的
  // 帳號信箱 —— 那是真人的 email,不能進公開的截圖。那行的文字隨語系翻譯,
  // 所以改用「含有 @ 的 .modeladmin__muted」來找,截圖前藏起來。
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.modeladmin__muted')) {
      if ((el.textContent ?? '').includes('@')) el.style.display = 'none';
    }
  });
  await sleep(300);
  await shooter.shot(page, 'model-admin', '模型管理(可用模型與價格)', '#/model-admin', { fullPage: true });

  await nav(page, '/system', 2000);
  // 絕不按更新確認鈕,也絕不碰 UI-TARS 開關:只截畫面。
  await shooter.shot(page, 'system-update', '系統更新:已部署版本與可用版本', '#/system');
  const uitars = page.locator('.sysupd__card:has(#uitars-title)');
  if (await uitars.count()) {
    await uitars.scrollIntoViewIfNeeded();
    await sleep(400);
    await shooter.shot(uitars, 'system-uitars', 'UI-TARS 定位模型開關(維持關閉)', '#/system');
  }
  const logs = page.locator('.sysupd__card:has(.syslog__field)');
  if (await logs.count()) {
    await logs.scrollIntoViewIfNeeded();
    await sleep(400);
    await shooter.shot(logs, 'system-logs', '集中日誌:查詢條件(尚未查詢)', '#/system');
  }

  // (弱點 b)任務清單先等骨架消失、等到有列或空狀態才拍,30 秒內等不到就失敗。
  await nav(page, `/apps/${encodeURIComponent(webApp.id)}?tab=tasks`, 500);
  await page.waitForSelector('.listpage__skeleton', { state: 'detached', timeout: 30_000 });
  await page.waitForSelector('.tasks__table, .listpage__empty', { timeout: 30_000 });
  await settle(page, 500);
  await shooter.shot(page, 'workspace-tasks', '應用工作區:測試任務', `${wsRoute}?tab=tasks`, { fullPage: true });

  await fillSubmitForm(page, ctx.caseName, hideCustomKbs);
  await shooter.shot(page, 'task-submit-form', '提交測試任務(已填好的表單)', `${wsRoute}?tab=tasks`, {
    fullPage: true,
  });
  await context.close();
}

/** 階段 2:用第一個語系的畫面真的送出任務,回傳 jobId。 */
async function submitRealTask(browser, api, locale, ctx) {
  const { context, page } = await openSession(browser, api, locale);
  await page.goto(`${SITE}/#/apps/${encodeURIComponent(ctx.webAppId)}?tab=tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tasks__submit-btn', { timeout: 30_000 });
  await settle(page, 1000);
  await fillSubmitForm(page, ctx.caseName, makeHideCustomKbs(page, ctx.customKbNames));

  const listPath = `/tasks?app=${encodeURIComponent(ctx.webAppId)}&limit=50`;
  const before = new Set(((await api.get(listPath)).items ?? []).map((x) => x.jobId));
  await page.locator('.tasks__go').click();
  try {
    await page.waitForSelector('.tasks__form', { state: 'detached', timeout: 90_000 });
  } catch {
    // 表單沒關就是後端退回了:把畫面上的錯誤文字帶進例外,不然只看到一個沒頭沒尾的 timeout。
    const msg = await page.locator('.tasks__error').first().textContent().catch(() => null);
    throw new Error(`提交任務失敗:${msg ?? '(畫面沒有錯誤訊息)'}`);
  }
  await context.close();

  let jobId = null;
  for (let i = 0; i < 30 && !jobId; i++) {
    const items = (await api.get(listPath)).items ?? [];
    jobId = items.map((x) => x.jobId).find((id) => !before.has(id)) ?? null;
    if (!jobId) await sleep(2000);
  }
  if (!jobId) throw new Error('送出後找不到新任務');
  return jobId;
}

// GET /tasks/{id} 回的是 { job, state, verdict, message, steps: [...] } —— 步數是 steps 的長度。
const stepsOf = (t) => (Array.isArray(t.steps) ? t.steps.length : 0);

/** 階段 3:任務執行中才有的畫面。任務若已結束就大聲失敗,不默默略過。 */
async function phaseLive(browser, api, locale, shooter, ctx) {
  const task = await api.get(`/tasks/${encodeURIComponent(ctx.jobId)}`);
  if (TERMINAL.has(task.state)) {
    throw new Error(`執行中的畫面還沒拍完任務就結束了(${locale},狀態 ${task.state}):請重跑,不略過`);
  }
  log(`\n【${locale}】執行中的畫面(任務狀態 ${task.state} · 步數 ${stepsOf(task)})`);
  const { context, page } = await openSession(browser, api, locale);
  await page.goto(`${SITE}/#/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 30_000 });
  await settle(page, 1500);
  await shooter.shot(page, 'tasks-running', '測試任務清單(有任務在執行中)', '#/tasks', { fullPage: true });

  await nav(page, `/tasks/${encodeURIComponent(ctx.jobId)}`, 2500);
  await shooter.shot(page, 'task-detail-live', '任務詳情:執行中的即時畫面與「這一刻」', '#/tasks/:jobId');
  await openPane(page, PANE.logs);
  await shooter.shot(page, 'task-detail-live-logs', '任務詳情:執行中的完整日誌', '#/tasks/:jobId');

  const popout = await context.newPage();
  await popout.emulateMedia({ reducedMotion: 'reduce' });
  await popout.goto(`${SITE}/#/live/${encodeURIComponent(ctx.jobId)}`, { waitUntil: 'domcontentloaded' });
  await settle(popout, 3000);
  await shooter.shot(popout, 'live-popout', '彈出式即時畫面(只有畫面本身)', '#/live/:jobId');
  await popout.close();
  await context.close();

  const after = await api.get(`/tasks/${encodeURIComponent(ctx.jobId)}`);
  if (TERMINAL.has(after.state)) {
    throw new Error(`拍執行中畫面的途中任務結束了(${locale},狀態 ${after.state}):請重跑,不略過`);
  }
}

/** (弱點 c)在數據分析分頁勾至少 2 個指標,並確認「已追蹤」的卡片真的出現。 */
async function trackMetrics(page) {
  const toggle = page.locator('.lana .devlogs__bar > .devlogs__btn').first();
  await toggle.waitFor({ timeout: 30_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const options = page.locator('.lana__option input[type="checkbox"]');
  const available = await options.count();
  if (available < 2) {
    throw new Error(`數據分析分頁只有 ${available} 個可勾選的指標:這次執行沒有產生足夠的指標資料,不拍空面板`);
  }
  for (let i = 0; i < 2; i++) {
    const box = options.nth(i);
    if (!(await box.isChecked())) await box.check();
  }
  await toggle.click(); // 收起挑選器,讓卡片完整露出
  await settle(page, 800);
  const cards = await page.locator('.lana__card').count();
  if (cards < 2) throw new Error(`勾了 2 個指標但只出現 ${cards} 張卡片(仍是「0 個已追蹤」的狀態)`);
}

/** 階段 4:任務結束後的畫面(任務詳情、報告、記憶地圖)。 */
async function phasePostRun(browser, api, locale, shooter, ctx) {
  const wsRoute = '#/apps/:appId';
  log(`\n【${locale}】結束後的畫面`);
  const { context, page } = await openSession(browser, api, locale);
  await page.goto(`${SITE}/#/tasks/${encodeURIComponent(ctx.jobId)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.topbar', { timeout: 30_000 });
  await settle(page, 3000);

  await openPane(page, PANE.trace);
  await shooter.shot(page, 'task-detail-trace', '任務詳情:執行軌跡', '#/tasks/:jobId');
  await openPane(page, PANE.logs);
  await shooter.shot(page, 'task-detail-logs', '任務詳情:完整日誌', '#/tasks/:jobId');
  await openPane(page, PANE.analysis);
  await trackMetrics(page);
  await shooter.shot(page, 'task-detail-analysis', '任務詳情:數據分析', '#/tasks/:jobId');
  await openPane(page, PANE.usage);
  await shooter.shot(page, 'task-detail-usage', '任務詳情:Token 用量與花費', '#/tasks/:jobId');
  await openPane(page, PANE.script);
  await shooter.shot(page, 'task-detail-script', '任務詳情:腳本與執行資訊', '#/tasks/:jobId');
  // AI 問答:先問一句中性的問題,圖裡才有真的內容而不是空面板。
  await openPane(page, PANE.ask);
  await ask(page, '.taskask', 'Which step took the longest, and why?');
  await shooter.shot(page, 'task-detail-ask', '任務詳情:AI 問答', '#/tasks/:jobId');

  await nav(page, '/reports', 1500);
  await shooter.shot(page, 'reports', '測試報告清單', '#/reports', { fullPage: true });

  await nav(page, `/reports/${encodeURIComponent(ctx.jobId)}`, 3500);
  await shooter.shot(page, 'report-cover', '測試報告:封面與結論', '#/reports/:jobId');
  for (const [id, slug, label] of [
    ['srep-acceptance', 'report-acceptance', '測試報告:驗收標準逐條判定'],
    ['srep-verdicts', 'report-verdicts', '測試報告:判定明細'],
    ['srep-evidence', 'report-evidence', '測試報告:證據截圖'],
    ['srep-release', 'report-release', '測試報告:放行建議'],
  ]) {
    if (!(await scrollToId(page, id))) throw new Error(`報告沒有 ${id} 這一節(${locale})`);
    await shooter.shot(page, slug, label, '#/reports/:jobId');
  }

  const launcher = page.locator('.rasst__launch');
  await launcher.waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await launcher.click();
  await page.waitForSelector('.rasst');
  await settle(page, 800);
  await shooter.shot(page, 'report-assistant-guide', '報告助手:導讀', '#/reports/:jobId');
  const atabs = page.locator('.rasst__tab');
  if ((await atabs.count()) < 3) throw new Error(`報告助手分頁少於 3 個(${await atabs.count()})`);
  await atabs.nth(1).click();
  await settle(page, 800);
  await ask(page, '.rasst .taskask', 'Which acceptance item has the weakest evidence behind it?');
  // (弱點 d)用元素截圖拍整個助手面板;面板仍被裁掉的話把視窗高度拉到 1000 再拍。
  const panel = page.locator('.rasst').first();
  await panel.scrollIntoViewIfNeeded();
  const box = await panel.boundingBox();
  if (box && box.y + box.height > VIEWPORT.height) await page.setViewportSize({ width: VIEWPORT.width, height: 1000 });
  await sleep(300);
  await shooter.shot(panel, 'report-assistant-ask', '報告助手:問答', '#/reports/:jobId');
  await page.setViewportSize(VIEWPORT);
  await atabs.nth(2).click();
  await settle(page, 800);
  await shooter.shot(page, 'report-assistant-review', '報告助手:判定覆核(誤判回報)', '#/reports/:jobId');

  await nav(page, `/apps/${encodeURIComponent(ctx.webAppId)}?tab=memory`, 2500);
  await shooter.shot(page, 'workspace-memory', '應用工作區:記憶地圖', `${wsRoute}?tab=memory`, { fullPage: true });

  await nav(page, `/memory?app=${encodeURIComponent(ctx.webAppId)}`, 2500);
  await page.locator('.memory__tab').first().click();
  await settle(page, 1200);
  await shooter.shot(page, 'memory-graph', '記憶地圖:關係圖', '#/memory', { fullPage: true });
  await page.locator('.memory__tab').nth(1).click();
  await settle(page, 1200);
  await shooter.shot(page, 'memory-grid', '記憶地圖:樣片本', '#/memory', { fullPage: true });
  const card = page.locator('.memory__card-btn').first();
  if (await card.count()) {
    await card.click();
    await page.waitForSelector('.studio__tabs', { timeout: 20_000 }).catch(() => {});
    await page.locator('.memmap__studio-anchor').scrollIntoViewIfNeeded().catch(() => {});
    await settle(page, 1200);
    await shooter.shot(page, 'memory-screen-studio', '記憶地圖:畫面工作區(ScreenStudio)', '#/memory');
  } else {
    log('   記憶地圖沒有畫面節點,略過 ScreenStudio(各語系的檔名集合會因此不一致時,最後會失敗)');
  }
  await context.close();
}

// ────────────────────────── 主流程 ──────────────────────────

async function capture() {
  const { sdk, chromium } = await loadDeps();
  log('1) 讀取部署設定(唯讀)');
  const cfg = discoverConfig();
  log(`   pool=${cfg.userPoolId} api=${cfg.apiUrl}`);
  log(`   目標站台 ${SITE}`);
  await warnIfStaleTarget();

  const cognito = new sdk.CognitoIdentityProviderClient({ region: REGION });

  log('2) 準備臨時使用者');
  const password = await ensureTempUser(sdk, cognito, cfg.userPoolId);

  log('3) 登入並確認租戶');
  const tokens = await signIn(sdk, cognito, cfg.clientId, password);
  const claims = decodeIdToken(tokens.idToken);
  if (claims.tenantId !== TENANT) {
    throw new Error(`拒絕繼續:id token 的租戶是 ${claims.tenantId ?? '(無)'},不是 ${TENANT}`);
  }
  if (!claims.isAdmin) throw new Error('拒絕繼續:臨時使用者不在 admins 群組,管理頁截不到');
  log(`   租戶 ${claims.tenantId} · 管理員 ${claims.isAdmin}`);

  const api = makeApi(sdk, cognito, cfg.clientId, cfg.apiUrl, tokens);
  const violations = [];
  const shooters = new Map(LOCALES.map((l) => [l, makeShooter(l, violations)]));
  const ctx = { caseName: `${GAME_NAME} · lobby smoke`, webAppId: null, appIds: [], customKbNames: [], jobId: null };

  const browser = await chromium.launch({ headless: true });
  try {
    log('4) 送出前的畫面(五個語系,同一批資料)');
    for (const locale of LOCALES) await phasePreRun(browser, api, locale, shooters.get(locale), ctx);

    log('\n5) 送出一次真的 web 測試');
    ctx.jobId = await submitRealTask(browser, api, LOCALES[0], ctx);
    log(`   jobId=${ctx.jobId}`);

    log('6) 等任務真的跑起來(至少一步)');
    const startedAt = Date.now();
    let task = null;
    for (;;) {
      task = await api.get(`/tasks/${encodeURIComponent(ctx.jobId)}`);
      if (TERMINAL.has(task.state)) break;
      if (task.state === 'running' && stepsOf(task) >= 1) break;
      if (Date.now() - startedAt > RUN_TIMEOUT_MS) break;
      await sleep(5000);
    }
    log(`   狀態 ${task.state} · 步數 ${stepsOf(task)}`);
    if (task.state !== 'running') {
      throw new Error(`任務沒有進入執行中的狀態就走到 ${task.state}:拍不到只在執行中存在的畫面,請重跑`);
    }

    log('7) 執行中才有的畫面(五個語系都在這個時窗內拍)');
    for (const locale of LOCALES) await phaseLive(browser, api, locale, shooters.get(locale), ctx);

    log('\n8) 等任務結束');
    for (;;) {
      task = await api.get(`/tasks/${encodeURIComponent(ctx.jobId)}`);
      if (TERMINAL.has(task.state)) break;
      if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
        throw new Error(`任務超過 ${RUN_TIMEOUT_MS / 60_000} 分鐘還沒結束(狀態 ${task.state})`);
      }
      await sleep(10_000);
    }
    ctx.finalState = task.state;
    ctx.stepCount = stepsOf(task);
    log(`   最終狀態 ${task.state} · 步數 ${stepsOf(task)}`);
    // 報告引擎在任務結束後才寫報告文件,給它一點時間。
    await sleep(20_000);

    log('9) 結束後的畫面');
    for (const locale of LOCALES) await phasePostRun(browser, api, locale, shooters.get(locale), ctx);
  } finally {
    await browser.close();
  }

  // 輸出清單(docs/screenshots/manifest.json 是 gitignored 的工作檔)。
  const manifest = Object.fromEntries(LOCALES.map((l) => [l, shooters.get(l).manifest]));
  writeFileSync(join(OUT_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  log('\n── 擷取完成 ──');
  log(`應用:${ctx.appIds.join(' · ')}`);
  log(`任務:${ctx.jobId} · 最終狀態 ${ctx.finalState} · 步數 ${ctx.stepCount}`);
  for (const l of LOCALES) log(`圖片 ${l}:${manifest[l].length} 張,寫在 docs/screenshots/${l}/`);

  const problems = [];
  const refSlugs = manifest[LOCALES[0]].map((e) => `${e.file}`).join(',');
  for (const l of LOCALES) {
    if (manifest[l].map((e) => e.file).join(',') !== refSlugs) problems.push(`${l} 的檔名集合和 ${LOCALES[0]} 不一致`);
  }
  for (const v of violations) problems.push(`語言檢查 ${v.locale}/${v.file}(${v.slug}):${v.chars}`);
  if (problems.length > 0) {
    console.error('\n✗ 擷取完成但有問題:');
    for (const p of problems) console.error(`  - ${p}`);
    throw new Error(`${problems.length} 個問題(見上)`);
  }
  log('語言檢查:全部通過');
}

// ────────────────────────── 收尾 ──────────────────────────

/**
 * 清掉這次擷取建出來的東西:demo 租戶裡名字在白名單上的應用(DELETE /apps/{id} 會
 * 連帶清掉它的案例、任務、報告與記憶),然後刪掉臨時使用者。
 *
 * 密碼只活在擷取那一次的記憶體裡,所以這裡重設一次新密碼來登入 —— 同樣是隨機產生、
 * 只存記憶體,刪完使用者連帶作廢。白名單是硬性護欄:不在名單上的 id 一律不發 DELETE。
 */
async function teardown() {
  const { sdk } = await loadDeps();
  log('1) 讀取部署設定(唯讀)');
  const cfg = discoverConfig();
  const cognito = new sdk.CognitoIdentityProviderClient({ region: REGION });

  // 先確保使用者存在再清資料:上一次收尾可能已經刪掉使用者卻還沒刪完資料,
  // 那時若直接跳過清理,demo 租戶就會留下孤兒應用。使用者在最後一步一定會被刪掉。
  log('2) 以臨時使用者登入,清掉 demo 租戶的資料');
  const password = await ensureTempUser(sdk, cognito, cfg.userPoolId);
  const tokens = await signIn(sdk, cognito, cfg.clientId, password);
  const claims = decodeIdToken(tokens.idToken);
  if (claims.tenantId !== TENANT) {
    throw new Error(`拒絕繼續:id token 的租戶是 ${claims.tenantId ?? '(無)'},不是 ${TENANT}`);
  }
  const api = makeApi(sdk, cognito, cfg.clientId, cfg.apiUrl, tokens);
  const apps = (await api.get('/apps')).items ?? [];
  if (apps.length === 0) log('   demo 租戶沒有應用');
  for (const app of apps) {
    if (!SEEDED_APP_NAMES.includes(app.name)) {
      log(`   略過「${app.name}」(不在白名單上)`);
      continue;
    }
    // purgeApp 一次做不完會回 202 + done:false,要一直叫到做完。
    for (let i = 0; i < 20; i++) {
      const res = await api.del(`/apps/${encodeURIComponent(app.id)}`);
      if (res.done !== false) break;
      await sleep(2000);
    }
    log(`   已刪除應用「${app.name}」(${app.id})`);
  }

  log('3) 刪除臨時使用者');
  await cognito.send(new sdk.AdminDeleteUserCommand({ UserPoolId: cfg.userPoolId, Username: USER_EMAIL }));
  log(`   已刪除 ${USER_EMAIL}`);
  log('── 收尾完成 ──');
}

/**
 * --selftest:不連網。確認語言檢查抓得到植入的違規,而且 shooter 會把違規記進清單,
 * 這樣「檢查沒做事」的靜默失敗就不會發生。
 */
function runSelftest() {
  const planted = selftest();
  log(`selftest: 植入的違規字元 ${planted.plantedViolations} 被偵測到`);
  const flat = { evaluate: async () => ({ texts: ['Settings 設定'], maskedChars: 0 }) };
  const violations = [];
  const shooter = makeShooter('en', violations, { dryRun: true });
  // 假 page:只實作 evaluate 與 screenshot,證明 shot() 會把違規記下來。
  const fakePage = { ...flat, screenshot: async () => {} };
  return shooter
    .shot(fakePage, 'selftest', 'selftest', '#/')
    .then(() => {
      if (violations.length !== 1) throw new Error('selftest failed: shooter did not record the planted violation');
      log(`selftest: shooter 記錄了違規(${violations[0].chars})`);
      log('selftest 通過');
    });
}

if (process.argv.includes('--selftest')) {
  runSelftest().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
} else {
  const mode = process.argv.includes('--teardown') ? teardown : capture;
  mode().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
