#!/usr/bin/env node
/**
 * 使用說明書的截圖擷取器 —— 從實際部署的站台抓每一頁的畫面。
 *
 * 為什麼是「真的跑一次」而不是假資料:說明書的圖如果來自 mock,讀者照著做會看到不一樣的
 * 畫面。所以這支腳本建一個短命的 Cognito 使用者、在隔離租戶 `demo` 裡用合成名稱建應用與
 * 案例、送一次真的 web 測試,然後在任務「執行中」與「已結束」兩個時點各抓一輪 —— 有三個
 * 畫面只在執行中存在,有三個只在結束後存在。
 *
 * 這個 repo 是公開的,截圖進了歷史就purge不掉,所以:
 *   - 所有資料都在 `demo` 租戶,名稱一律是 Example Slots / com.example.slotsgame 這種合成值;
 *   - 登入前先解 id token 的 custom:tenantId,不是 demo 就中止(絕不對 default 租戶截圖);
 *   - 臨時使用者的密碼用 crypto.randomBytes 產生、只存在記憶體裡,不進 argv、不進 env、
 *     不進檔案、不進 log;
 *   - 跨租戶的頁面(成員 / 知識庫 / 真機與容器 / 集中日誌)先縮小範圍再截。
 *
 * 用法:
 *   node scripts/capture-screenshots.mjs              擷取(建使用者 → 建資料 → 跑測試 → 截圖)
 *   node scripts/capture-screenshots.mjs --teardown   清掉 demo 租戶的資料與臨時使用者
 *
 * 可用環境變數覆寫:PA_SITE_URL / PA_REGION / PA_STACK_PREFIX / PA_TENANT / PA_USER_EMAIL。
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { chromium } from 'playwright';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(repoRoot, 'docs', 'screenshots');

const SITE = process.env.PA_SITE_URL ?? 'https://d2sd3fmuly1j9g.cloudfront.net';
const REGION = process.env.PA_REGION ?? 'us-west-2';
const STACK_PREFIX = process.env.PA_STACK_PREFIX ?? 'PlayAgentDev';
const TENANT = process.env.PA_TENANT ?? 'demo';
const USER_EMAIL = process.env.PA_USER_EMAIL ?? 'qa-demo@example.com';
const ADMIN_GROUP = 'admins';

/** 只有這些名字的應用可以被 --teardown 刪掉(絕不碰不是這支腳本建的東西)。 */
const SEEDED_APP_NAMES = ['Example Slots', 'Example Slots Mobile'];

/** 任務的終止狀態(對齊 AppWorkspacePage.tsx 的 TERMINAL)。 */
const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);

const VIEWPORT = { width: 1280, height: 800 };
/** 等任務結束的上限:超過就用當下的狀態繼續截圖(報告頁可能只有部分內容)。 */
const RUN_TIMEOUT_MS = 20 * 60_000;

const log = (...a) => console.log(...a);

// ───────────────────────────── 工具 ─────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ────────────────────────── 臨時使用者 ──────────────────────────

/**
 * 建臨時使用者:custom:tenantId 在池裡是 mutable:false,所以一定要在 AdminCreateUser
 * 當下就設好,事後改不了。加入 admins 群組必須在登入之前 —— cognito:groups 是寫進
 * id token 的,之後才加要重新登入才看得到管理頁。
 */
async function ensureTempUser(cognito, userPoolId) {
  const password = generatePassword();
  let existed = true;
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: USER_EMAIL }));
  } catch (err) {
    if (err?.name !== 'UserNotFoundException') throw err;
    existed = false;
  }

  if (!existed) {
    await cognito.send(
      new AdminCreateUserCommand({
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
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: USER_EMAIL,
      Password: password,
      Permanent: true,
    }),
  );
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: USER_EMAIL,
      GroupName: ADMIN_GROUP,
    }),
  );
  return password;
}

/** USER_PASSWORD_AUTH 登入(app client 沒有 secret,與前端走同一條路)。 */
async function signIn(cognito, clientId, password) {
  const res = await cognito.send(
    new InitiateAuthCommand({
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
function makeApi(cognito, clientId, apiUrl, tokens) {
  const state = { tokens };
  const fresh = async () => {
    if (state.tokens.expiresAt - Date.now() > 5 * 60_000 || !state.tokens.refreshToken) return state.tokens;
    const res = await cognito.send(
      new InitiateAuthCommand({
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
  return { get: (p) => call('GET', p), del: (p) => call('DELETE', p), tokens: () => state.tokens };
}

// ────────────────────────── 截圖 ──────────────────────────

function makeShooter() {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];
  let n = 0;
  /**
   * 寫一張圖。target 可以是 page(整個視窗)或 locator(只截那一塊)。
   * 編號只在成功後才前進,所以檔名永遠連號。
   */
  const shot = async (target, slug, label, route, opts = {}) => {
    const file = `${String(n + 1).padStart(2, '0')}-${slug}.png`;
    // 整頁截圖前先回到頂端:頂欄是 sticky 的,頁面捲過之後拍整頁會讓它卡在畫面中間。
    if (opts.fullPage && typeof target.evaluate === 'function') {
      await target.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await sleep(250);
    }
    await target.screenshot({ path: join(OUT_DIR, file), ...opts });
    n += 1;
    manifest.push({ file, route, label });
    log(`  [${file}] ${label}`);
    return file;
  };
  const flush = () => {
    writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  };
  return { shot, flush, manifest };
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
 * 切到任務詳情頁右側的某個分頁。
 *
 * 不能用索引:TaskDetailPage 同時渲染三組 .dstage__tabs(手機畫面下方的「與畫面互動」、
 * 右側對話欄、中間事件欄),其中兩組會依目前分頁被 hidden 起來,所以同一個索引可能落在
 * 看不見的那一份上。改用「看得見的 + 分頁標籤文字」來定位。
 */
async function openPane(page, label) {
  const tab = page.locator('.dstage__tab:visible').filter({ hasText: label }).first();
  if (!(await tab.count())) return false;
  await tab.click();
  await settle(page, 1200);
  return true;
}

/**
 * 在某個 AI 問答面板裡問一句話,等答案真的回來。
 *
 * 不能只等「忙碌中」的列消失:剛送出時那一列還沒掛上,條件立刻為真,就會拍到一個空面板。
 * 所以先等自己的那句話出現,再等至少一則非忙碌的回覆。
 */
async function ask(page, scope, question) {
  const box = page.locator(`${scope}__form textarea`).first();
  if (!(await box.count())) return false;
  await box.fill(question);
  await box.press('Enter');
  await page.waitForSelector(`${scope}__msg`, { timeout: 30_000 }).catch(() => {});
  await page
    .waitForFunction(
      (sel) => {
        const msgs = document.querySelectorAll(`${sel}__msg--assistant`);
        return [...msgs].some((el) => !el.classList.contains('taskask__msg--busy'));
      },
      scope,
      { timeout: 180_000 },
    )
    .catch(() => {});
  await settle(page, 1500);
  return true;
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
 */
async function createApp(page, { name, platform, identifier, shooter, formSlug }) {
  await nav(page, '/apps');
  const exists = (await page.locator('.apps__card-name', { hasText: name }).count()) > 0;

  // 表單一律填一次:即使應用已經存在(重跑時),說明書還是需要這張「填好的建立表單」。
  await page.click('.apps__create-btn');
  await page.waitForSelector('.apps__form');
  const grid = page.locator('.apps__form-grid');
  await grid.locator('.apps__field').first().locator('input').fill(name);
  await grid.locator('select').first().selectOption(platform);
  // 遊戲類型是自繪的 listbox(原生 option 塞不進 SVG),所以要點開再選。
  await grid.locator('.iconselect__button').first().click();
  await page.locator('.iconselect__option-label', { hasText: /^Slot$/ }).first().click();
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
    log(`  應用「${name}」已存在,沿用`);
    return;
  }
  await page.click('.apps__submit');
  await page.waitForSelector('.apps__form', { state: 'detached', timeout: 30_000 });
  await settle(page);
  log(`  建立應用「${name}」`);
}

/**
 * 這一份 YAML 刻意不含任何像密鑰的鍵:cases.ts 的 assertNoLiteralSecrets 會擋字面量密鑰。
 * 任務寫得很窄(兩條驗收 + 明確的停止條件)—— example.com 只有一個連結,目標一旦開放,
 * agent 會在同一個畫面上反覆試到步數用完,報告就只剩「受阻」而沒有實質判定。
 */
const CASE_YAML = `url: https://example.com
task: |
  Open the page, confirm the heading is readable, then click the only link in
  the page body and confirm the next page renders. Stop after that.
acceptance:
  - category: Lobby
    module: Page load
    purpose: The start page finishes loading and shows its heading
    steps:
      - Open the start URL
    expected: The heading of the page is visible and legible
  - category: Lobby
    module: Primary link
    purpose: The only link in the page body is reachable
    steps:
      - Click the link in the page body
    expected: A different page renders and shows a heading of its own
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
    'Open the Example Slots start page, confirm the heading loads, then follow the only link and confirm the next page renders.',
  );
  await settle(page, 400);
  await shooter.shot(page, 'case-form-nl', '測試案例:自然語言描述模式', '#/apps/:appId?tab=cases');
  const acceptance = page.locator('.cases__form .acc').first();
  if (await acceptance.count()) {
    // 「帶入範例」填的是 sampleAcceptanceItems('en')(程式碼裡的中性範例列),
    // 空表格截出來看不出這個編輯器在做什麼。
    const insert = acceptance.getByRole('button', { name: /insert example/i });
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
    log(`  案例「${caseName}」已存在,沿用`);
    return;
  }
  await page.click('.cases__submit');
  await page.waitForSelector('.cases__form', { state: 'detached', timeout: 30_000 });
  await settle(page);
  log(`  建立案例「${caseName}」`);
}

// ────────────────────────── 主流程 ──────────────────────────

async function capture() {
  log('1) 讀取部署設定(唯讀)');
  const cfg = discoverConfig();
  log(`   pool=${cfg.userPoolId} api=${cfg.apiUrl}`);

  const cognito = new CognitoIdentityProviderClient({ region: REGION });

  log('2) 準備臨時使用者');
  const password = await ensureTempUser(cognito, cfg.userPoolId);

  log('3) 登入並確認租戶');
  const tokens = await signIn(cognito, cfg.clientId, password);
  const claims = decodeIdToken(tokens.idToken);
  if (claims.tenantId !== TENANT) {
    throw new Error(`拒絕繼續:id token 的租戶是 ${claims.tenantId ?? '(無)'},不是 ${TENANT}`);
  }
  if (!claims.isAdmin) throw new Error('拒絕繼續:臨時使用者不在 admins 群組,管理頁截不到');
  log(`   租戶 ${claims.tenantId} · 管理員 ${claims.isAdmin}`);

  const api = makeApi(cognito, cfg.clientId, cfg.apiUrl, tokens);
  const shooter = makeShooter();

  const browser = await chromium.launch({ headless: true });
  const created = { appIds: [], jobId: null, finalState: null };
  try {
    // 登入頁要在「沒有 token」的情境下截,所以另開一個乾淨 context。
    log('4) 截圖:登入頁');
    {
      const anon = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'en-US' });
      await anon.addInitScript(() => {
        window.localStorage.setItem('playagent.locale', 'en');
      });
      const p = await anon.newPage();
      await p.emulateMedia({ reducedMotion: 'reduce' });
      await p.goto(`${SITE}/#/guide`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('.login__card');
      await settle(p);
      await shooter.shot(p, 'login', '登入頁(欄位尚未填寫)', '#/');
      await anon.close();
    }

    // 已登入的 context:token 由 addInitScript 注入 localStorage(與前端 tokenStore 同一個 key)。
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'en-US' });
    await context.addInitScript(
      ([auth]) => {
        window.localStorage.setItem('playagent.locale', 'en');
        window.localStorage.setItem('playagent.auth', auth);
      },
      [JSON.stringify(api.tokens())],
    );
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${SITE}/#/guide`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.topbar', { timeout: 30_000 });
    await settle(page, 1200);

    log('5) 截圖:使用指南');
    await shooter.shot(page, 'guide', '使用指南(14 個章節)', '#/guide', { fullPage: true });

    log('6) 種資料:兩個應用 + 一個案例');
    await createApp(page, {
      name: 'Example Slots',
      platform: 'web',
      identifier: 'https://example.com',
      shooter,
      formSlug: 'apps-create-form',
    });
    await createApp(page, {
      name: 'Example Slots Mobile',
      platform: 'android',
      identifier: 'com.example.slotsgame',
      shooter: null,
    });

    const apps = (await api.get('/apps')).items ?? [];
    const webApp = apps.find((a) => a.name === 'Example Slots');
    const mobileApp = apps.find((a) => a.name === 'Example Slots Mobile');
    if (!webApp) throw new Error('建立後找不到 Example Slots');
    created.appIds = [webApp, mobileApp].filter(Boolean).map((a) => `${a.name}=${a.id}`);
    log(`   ${created.appIds.join(' · ')}`);

    await nav(page, '/apps');
    await settle(page, 900);
    await shooter.shot(page, 'apps', '應用管理(卡片牆)', '#/apps', { fullPage: true });

    const caseName = 'Example Slots · lobby smoke';
    await createCase(page, webApp.id, caseName, shooter);

    // 知識庫是跨租戶共用資源(listKnowledgeBases 讀 shared/):別的租戶自建的那幾座
    // 會用真實的遊戲名字命名,不能出現在公開截圖裡。先問 API 哪幾座不是內建的,
    // 之後每次要截到知識庫清單前先把那幾列藏掉。
    const customKbNames = ((await api.get('/knowledge-bases')).items ?? [])
      .filter((kb) => !kb.builtin)
      .map((kb) => String(kb.name ?? '').trim())
      .filter(Boolean);
    const hideCustomKbs = async () => {
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
    if (customKbNames.length > 0) {
      log(`   ${customKbNames.length} 座非內建知識庫會在截圖前隱藏(跨租戶共用資源)`);
    }

    log('7) 截圖:工作區分頁');
    const wsRoute = '#/apps/:appId';
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

    log('8) 截圖:靜態頁');
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
    // 帳號信箱 —— 那是真人的 email,不能進公開的截圖,截圖前先把那一行藏起來。
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.modeladmin__muted')) {
        if (/last saved/i.test(el.textContent ?? '')) el.style.display = 'none';
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

    log('9) 送出一次真的 web 測試');
    await nav(page, `/apps/${encodeURIComponent(webApp.id)}?tab=tasks`, 1500);
    await shooter.shot(page, 'workspace-tasks', '應用工作區:測試任務', `${wsRoute}?tab=tasks`, { fullPage: true });

    await page.locator('.tasks__submit-btn').first().click();
    await page.waitForSelector('.tasks__form');
    // 案例下拉選我們剛建的那一筆;執行環境留平台預設(web → Web browser),模型留三個預設席位。
    const caseSelect = page.locator('.tasks__form select').first();
    await caseSelect.selectOption({ label: caseName });
    await settle(page, 800);
    // 上限:步數與預算都設小一點,把這次示範的花費框住。
    await page.locator('.tform__adv > summary').click();
    await page.locator('.tform__adv input[type="number"]').nth(0).fill('10');
    await page.locator('.tform__adv input[type="number"]').nth(1).fill('1');
    await settle(page, 500);
    await hideCustomKbs();
    await shooter.shot(page, 'task-submit-form', '提交測試任務(已填好的表單)', `${wsRoute}?tab=tasks`, {
      fullPage: true,
    });

    const before = new Set(((await api.get(`/tasks?app=${encodeURIComponent(webApp.id)}&limit=50`)).items ?? []).map((x) => x.jobId));
    await page.locator('.tasks__go').click();
    try {
      await page.waitForSelector('.tasks__form', { state: 'detached', timeout: 90_000 });
    } catch {
      // 表單沒關就是後端退回了:把畫面上的錯誤文字帶進例外,不然只看到一個沒頭沒尾的 timeout。
      const msg = await page.locator('.tasks__error').first().textContent().catch(() => null);
      throw new Error(`提交任務失敗:${msg ?? '(畫面沒有錯誤訊息)'}`);
    }

    // 找出新任務的 jobId。
    let jobId = null;
    for (let i = 0; i < 30 && !jobId; i++) {
      const items = (await api.get(`/tasks?app=${encodeURIComponent(webApp.id)}&limit=50`)).items ?? [];
      jobId = items.map((x) => x.jobId).find((id) => !before.has(id)) ?? null;
      if (!jobId) await sleep(2000);
    }
    if (!jobId) throw new Error('送出後找不到新任務');
    created.jobId = jobId;
    log(`   jobId=${jobId}`);

    log('10) 等任務真的跑起來(至少一步)');
    const startedAt = Date.now();
    // GET /tasks/{id} 回的是 { job, state, verdict, message, steps: [...] } —— 步數在
    // steps 陣列的長度,不是清單 API 的 stepCount。
    const stepsOf = (t) => (Array.isArray(t.steps) ? t.steps.length : 0);
    let task = null;
    for (;;) {
      task = await api.get(`/tasks/${encodeURIComponent(jobId)}`);
      if (TERMINAL.has(task.state)) break;
      if (task.state === 'running' && stepsOf(task) >= 1) break;
      if (Date.now() - startedAt > RUN_TIMEOUT_MS) break;
      await sleep(5000);
    }
    log(`   狀態 ${task.state} · 步數 ${stepsOf(task)}`);

    if (!TERMINAL.has(task.state)) {
      log('11) 截圖:執行中才有的畫面');
      await nav(page, '/tasks', 1500);
      await shooter.shot(page, 'tasks-running', '測試任務清單(有任務在執行中)', '#/tasks', { fullPage: true });

      await nav(page, `/tasks/${encodeURIComponent(jobId)}`, 2500);
      await shooter.shot(page, 'task-detail-live', '任務詳情:執行中的即時畫面與「這一刻」', '#/tasks/:jobId');
      if (await openPane(page, 'Full logs')) {
        await shooter.shot(page, 'task-detail-live-logs', '任務詳情:執行中的完整日誌', '#/tasks/:jobId');
      }

      const popout = await context.newPage();
      await popout.emulateMedia({ reducedMotion: 'reduce' });
      await popout.goto(`${SITE}/#/live/${encodeURIComponent(jobId)}`, { waitUntil: 'domcontentloaded' });
      await settle(popout, 3000);
      await shooter.shot(popout, 'live-popout', '彈出式即時畫面(只有畫面本身)', '#/live/:jobId');
      await popout.close();
    } else {
      log('11) 任務已經結束,跳過執行中的三張圖');
    }

    log('12) 等任務結束');
    for (;;) {
      task = await api.get(`/tasks/${encodeURIComponent(jobId)}`);
      if (TERMINAL.has(task.state)) break;
      if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
        log('   超過 20 分鐘上限,用當下狀態繼續');
        break;
      }
      await sleep(10_000);
    }
    created.finalState = task.state;
    created.stepCount = stepsOf(task);
    log(`   最終狀態 ${task.state} · 步數 ${stepsOf(task)}`);
    // 報告引擎在任務結束後才寫報告文件,給它一點時間。
    await sleep(20_000);

    log('13) 截圖:結束後的任務詳情');
    await nav(page, `/tasks/${encodeURIComponent(jobId)}`, 3000);
    const PANES = [
      ['Steps', 'task-detail-trace', '任務詳情:執行軌跡'],
      ['Full logs', 'task-detail-logs', '任務詳情:完整日誌'],
      ['Metrics', 'task-detail-analysis', '任務詳情:數據分析'],
      ['Token usage', 'task-detail-usage', '任務詳情:Token 用量與花費'],
      ['Script & run info', 'task-detail-script', '任務詳情:腳本與執行資訊'],
    ];
    for (const [tabLabel, slug, label] of PANES) {
      if (!(await openPane(page, tabLabel))) {
        log(`   找不到分頁「${tabLabel}」,略過`);
        continue;
      }
      await shooter.shot(page, slug, label, '#/tasks/:jobId');
    }
    // AI 問答:先問一句中性的問題,圖裡才有真的內容而不是空面板。
    if (await openPane(page, 'Ask AI')) {
      await ask(page, '.taskask', 'Which step took the longest, and why?');
      await shooter.shot(page, 'task-detail-ask', '任務詳情:AI 問答', '#/tasks/:jobId');
    }

    log('14) 截圖:報告');
    await nav(page, '/reports', 1500);
    await shooter.shot(page, 'reports', '測試報告清單', '#/reports', { fullPage: true });

    await nav(page, `/reports/${encodeURIComponent(jobId)}`, 3500);
    await shooter.shot(page, 'report-cover', '測試報告:封面與結論', '#/reports/:jobId');
    for (const [id, slug, label] of [
      ['srep-acceptance', 'report-acceptance', '測試報告:驗收標準逐條判定'],
      ['srep-verdicts', 'report-verdicts', '測試報告:判定明細'],
      ['srep-evidence', 'report-evidence', '測試報告:證據截圖'],
      ['srep-release', 'report-release', '測試報告:放行建議'],
    ]) {
      if (await scrollToId(page, id)) {
        await shooter.shot(page, slug, label, '#/reports/:jobId');
      } else {
        log(`   報告沒有 ${id} 這一節,略過`);
      }
    }

    const launcher = page.locator('.rasst__launch');
    if (await launcher.count()) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await launcher.click();
      await page.waitForSelector('.rasst');
      await settle(page, 800);
      await shooter.shot(page, 'report-assistant-guide', '報告助手:導讀', '#/reports/:jobId');
      const atabs = page.locator('.rasst__tab');
      if ((await atabs.count()) > 1) {
        await atabs.nth(1).click();
        await settle(page, 800);
        await ask(page, '.rasst .taskask', 'Which acceptance item has the weakest evidence behind it?');
        await shooter.shot(page, 'report-assistant-ask', '報告助手:問答', '#/reports/:jobId');
      }
      if ((await atabs.count()) > 2) {
        await atabs.nth(2).click();
        await settle(page, 800);
        await shooter.shot(page, 'report-assistant-review', '報告助手:判定覆核(誤判回報)', '#/reports/:jobId');
      }
    }

    log('15) 截圖:記憶地圖');
    await nav(page, `/apps/${encodeURIComponent(webApp.id)}?tab=memory`, 2500);
    await shooter.shot(page, 'workspace-memory', '應用工作區:記憶地圖', `${wsRoute}?tab=memory`, { fullPage: true });

    await nav(page, `/memory?app=${encodeURIComponent(webApp.id)}`, 2500);
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
      log('   記憶地圖沒有畫面節點,略過 ScreenStudio');
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const manifest = shooter.flush();
  log('');
  log('── 擷取完成 ──');
  log(`應用:${created.appIds.join(' · ')}`);
  log(`任務:${created.jobId} · 最終狀態 ${created.finalState}`);
  log(`圖片:${manifest.length} 張,寫在 docs/screenshots/`);
  for (const e of manifest) log(`  ${e.file}\t${e.route}\t${e.label}`);
}

// ────────────────────────── 收尾(FEAT-003)──────────────────────────

/**
 * 清掉這次擷取建出來的東西:demo 租戶裡名字在白名單上的應用(DELETE /apps/{id} 會
 * 連帶清掉它的案例、任務、報告與記憶),然後刪掉臨時使用者。
 *
 * 密碼只活在擷取那一次的記憶體裡,所以這裡重設一次新密碼來登入 —— 同樣是隨機產生、
 * 只存記憶體,刪完使用者連帶作廢。白名單是硬性護欄:不在名單上的 id 一律不發 DELETE。
 */
async function teardown() {
  log('1) 讀取部署設定(唯讀)');
  const cfg = discoverConfig();
  const cognito = new CognitoIdentityProviderClient({ region: REGION });

  // 先確保使用者存在再清資料:上一次收尾可能已經刪掉使用者卻還沒刪完資料,
  // 那時若直接跳過清理,demo 租戶就會留下孤兒應用。使用者在最後一步一定會被刪掉。
  log('2) 以臨時使用者登入,清掉 demo 租戶的資料');
  const password = await ensureTempUser(cognito, cfg.userPoolId);
  const tokens = await signIn(cognito, cfg.clientId, password);
  const claims = decodeIdToken(tokens.idToken);
  if (claims.tenantId !== TENANT) {
    throw new Error(`拒絕繼續:id token 的租戶是 ${claims.tenantId ?? '(無)'},不是 ${TENANT}`);
  }
  const api = makeApi(cognito, cfg.clientId, cfg.apiUrl, tokens);
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
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId: cfg.userPoolId, Username: USER_EMAIL }));
  log(`   已刪除 ${USER_EMAIL}`);
  log('── 收尾完成 ──');
}

const mode = process.argv.includes('--teardown') ? teardown : capture;
mode().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
