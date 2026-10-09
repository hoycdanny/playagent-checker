import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { isAuthConfigured } from '../config.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { InfoIcon, type InfoIconName } from '../components/tasks/InfoIcon.tsx';
import './LoginPage.css';

/** 社群登入預留:UI 先到位,實際串接(Cognito IdP)之後再做,故暫 disabled。 */
const SOCIAL_PROVIDERS = [
  { id: 'google', labelKey: 'auth.continueGoogle' as const, glyph: 'G' },
  { id: 'facebook', labelKey: 'auth.continueFacebook' as const, glyph: 'f' },
];

/** [繁中, English, 简中, 日本語, 한국어] */
type L5 = readonly [string, string, string, string, string];
const LOC_IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };

const INTRO = {
  eyebrow: ['AI 遊戲 / App 自動化測試', 'AI test automation for games and apps', 'AI 游戏 / App 自动化测试', 'AI によるゲーム/アプリ自動テスト', 'AI 게임 / 앱 자동화 테스트'] as L5,
  loopTitle: ['AI 怎麼測', 'How the AI tests', 'AI 怎么测', 'AI のテストの進め方', 'AI가 테스트하는 방법'] as L5,
  loop: [
    { icon: 'eye', title: ['截圖', 'Screenshot', '截图', 'スクリーンショット', '스크린샷'] as L5, desc: ['看到目前畫面', 'See the current screen', '看到当前画面', '今の画面を見る', '현재 화면 보기'] as L5 },
    { icon: 'target', title: ['看懂畫面', 'Understand', '看懂画面', '画面を理解', '화면 이해'] as L5, desc: ['找出要點的位置', 'Find what to tap', '找出要点的位置', 'タップ位置を特定', '누를 위치 찾기'] as L5 },
    { icon: 'sparkle', title: ['決定下一步', 'Decide', '决定下一步', '次の一手を決定', '다음 행동 결정'] as L5, desc: ['依目標選動作', 'Pick the next move', '按目标选动作', '目標に沿って選ぶ', '목표에 맞게 선택'] as L5 },
    { icon: 'gamepad', title: ['操作', 'Act', '操作', '操作', '조작'] as L5, desc: ['點擊、滑動、輸入', 'Tap, swipe, type', '点击、滑动、输入', 'タップ・スワイプ・入力', '탭, 스와이프, 입력'] as L5 },
  ] as const,
  loopNote: [
    '一直循環到完成或達到上限,最後自動產出含截圖、判定與花費的報告。',
    'It loops until the goal is met or a limit is hit, then writes a report with screenshots, verdicts and spend.',
    '一直循环到完成或达到上限,最后自动生成含截图、判定与花费的报告。',
    '目標達成か上限に達するまで繰り返し、最後にスクリーンショット・判定・費用入りのレポートを作成します。',
    '목표를 달성하거나 한도에 도달할 때까지 반복하고, 마지막에 스크린샷·판정·비용이 담긴 보고서를 만듭니다.',
  ] as L5,
  features: [
    {
      icon: 'sparkle',
      title: ['白話寫案例', 'Plain-language cases', '大白话写用例', '普段の言葉でテストケース', '쉬운 말로 테스트 케이스'] as L5,
      desc: ['一句話描述流程,AI 轉成可執行的測試案例;也能匯入 Excel 測試清單。', 'Describe a flow in a sentence and the AI turns it into a runnable case; Excel test lists can be imported too.', '一句话描述流程,AI 转成可执行的测试用例;也能导入 Excel 测试清单。', '流れを一文で書けば AI が実行可能なテストケースにします。Excel のテスト一覧も取り込めます。', '흐름을 한 문장으로 쓰면 AI가 실행 가능한 테스트 케이스로 만듭니다. Excel 테스트 목록도 가져올 수 있습니다.'] as L5,
    },
    {
      icon: 'eye',
      title: ['看畫面,不靠元件', 'Reads the screen', '看画面,不靠元件', '要素ではなく画面を見る', '요소가 아닌 화면을 봄'] as L5,
      desc: ['像真人一樣看螢幕操作,Unity、Cocos 這類沒有 UI 元件的遊戲也能測。', 'It operates by looking at the screen like a person, so Unity and Cocos games with no UI tree work too.', '像真人一样看屏幕操作,Unity、Cocos 这类没有 UI 元件的游戏也能测。', '人と同じように画面を見て操作するため、UI 要素のない Unity や Cocos のゲームもテストできます。', '사람처럼 화면을 보고 조작하므로 UI 요소가 없는 Unity, Cocos 게임도 테스트할 수 있습니다.'] as L5,
    },
    {
      icon: 'check',
      title: ['自動判定與報告', 'Verdicts and reports', '自动判定与报告', '自動判定とレポート', '자동 판정과 보고서'] as L5,
      desc: ['逐條判定成敗,附證據截圖、真機錄影、逐步軌跡與花費,支援五種語言。', 'Each assertion is judged with evidence screenshots, real-device recordings, a step trace and spend, in five languages.', '逐条判定成败,附证据截图、真机录屏、逐步轨迹与花费,支持五种语言。', '判定条件ごとに合否を出し、証拠スクリーンショット・実機録画・ステップ軌跡・費用を 5 言語で添えます。', '조건마다 합격 여부를 판정하고 증거 스크린샷, 실기기 녹화, 단계별 궤적, 비용을 5개 언어로 제공합니다.'] as L5,
    },
    {
      icon: 'hash',
      title: ['記憶地圖', 'Memory map', '记忆地图', 'メモリマップ', '메모리 맵'] as L5,
      desc: ['走過的畫面累積成一張地圖,下一次更快走到要測的地方。', 'Visited screens build up into a map, so the next run reaches the test point faster.', '走过的画面累积成一张地图,下一次更快走到要测的地方。', 'たどった画面が地図として蓄積され、次回はテスト地点に早くたどり着けます。', '방문한 화면이 지도로 쌓여 다음 실행은 테스트 지점에 더 빨리 도달합니다.'] as L5,
    },
    {
      icon: 'book',
      title: ['知識庫', 'Knowledge bases', '知识库', 'ナレッジベース', '지식 베이스'] as L5,
      desc: ['掛上遊戲類型知識或自己的 PDF 文件,AI 更懂這款遊戲的規則與術語。', 'Attach genre knowledge or your own PDFs so the AI understands the game\'s rules and terms.', '挂上游戏类型知识或自己的 PDF 文档,AI 更懂这款游戏的规则与术语。', 'ジャンル別のナレッジや自社の PDF を付けると、AI がゲームのルールや用語を理解します。', '장르 지식이나 자체 PDF를 붙이면 AI가 게임의 규칙과 용어를 이해합니다.'] as L5,
    },
    {
      icon: 'coin',
      title: ['成本看得見', 'Cost under control', '成本看得见', 'コストを管理', '비용 관리'] as L5,
      desc: ['每個任務可設步數與預算上限,價格不明就不執行;沒有任務時幾乎不花錢。', 'Set step and budget limits per task; unknown prices are refused, and idle cost is close to zero.', '每个任务可设步数与预算上限,价格不明就不执行;没有任务时几乎不花钱。', 'タスクごとにステップと予算の上限を設定でき、価格不明なら実行しません。待機中の費用はほぼゼロです。', '작업마다 단계와 예산 한도를 설정할 수 있고, 가격을 모르면 실행하지 않습니다. 대기 중 비용은 거의 없습니다.'] as L5,
    },
  ] as const,
  runtimesTitle: ['支援的執行環境', 'Where tests run', '支持的执行环境', '対応する実行環境', '지원하는 실행 환경'] as L5,
  runtimes: [
    { icon: 'cloud', name: ['Web 瀏覽器', 'Web browser', 'Web 浏览器', 'Web ブラウザー', '웹 브라우저'] as L5 },
    { icon: 'phone', name: ['Android 真機', 'Android device', 'Android 真机', 'Android 実機', 'Android 실기기'] as L5 },
    { icon: 'phone', name: ['iOS 真機', 'iOS device', 'iOS 真机', 'iOS 実機', 'iOS 실기기'] as L5 },
    { icon: 'package', name: ['Android 容器', 'Android container', 'Android 容器', 'Android コンテナ', 'Android 컨테이너'] as L5 },
    { icon: 'cpu', name: ['Windows PC 遊戲', 'Windows PC games', 'Windows PC 游戏', 'Windows PC ゲーム', 'Windows PC 게임'] as L5 },
  ] as const,
  foot: [
    '部署在你自己的 AWS 帳號,資料依租戶隔離;帳號由管理員建立。',
    'Runs in your own AWS account with per-tenant data isolation; accounts are created by an admin.',
    '部署在你自己的 AWS 账号,数据按租户隔离;账号由管理员创建。',
    'ご自身の AWS アカウントで動作し、データはテナントごとに分離されます。アカウントは管理者が作成します。',
    '자체 AWS 계정에서 실행되며 데이터는 테넌트별로 분리됩니다. 계정은 관리자가 만듭니다.',
  ] as L5,
};

function introText(locale: string) {
  const i = LOC_IDX[locale] ?? 1;
  const p = (t: L5) => t[i] ?? t[1];
  return {
    eyebrow: p(INTRO.eyebrow),
    loopTitle: p(INTRO.loopTitle),
    loop: INTRO.loop.map((s) => ({ icon: s.icon as InfoIconName, title: p(s.title), desc: p(s.desc) })),
    loopNote: p(INTRO.loopNote),
    features: INTRO.features.map((f) => ({ icon: f.icon as InfoIconName, title: p(f.title), desc: p(f.desc) })),
    runtimesTitle: p(INTRO.runtimesTitle),
    runtimes: INTRO.runtimes.map((r) => ({ icon: r.icon as InfoIconName, name: p(r.name) })),
    foot: p(INTRO.foot),
  };
}

export function LoginPage() {
  const { t, locale } = useI18n();
  const L = introText(locale);
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = isAuthConfigured();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') {
        setError(t('auth.errorInvalid'));
      } else {
        setError(t('auth.errorGeneric'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      {/* 左側:品牌與系統用途介紹,讓第一次來的人知道這是什麼、能做什麼 */}
      <aside className="login__intro" aria-labelledby="login-intro-title">
        <div className="login__intro-inner">
          <div className="login__brand">
            <span className="login__logo" aria-hidden="true">▸</span>
            <span className="login__brand-name">{t('app.name')}</span>
          </div>
          <p className="login__eyebrow">{L.eyebrow}</p>
          <h2 id="login-intro-title" className="login__lead">{t('auth.introLead')}</h2>

          {/* AI 怎麼測:一圈迴圈 */}
          <section className="login__loop" aria-label={L.loopTitle}>
            <h3 className="login__section-title">{L.loopTitle}</h3>
            <ol className="login__loop-steps">
              {L.loop.map((s, i) => (
                <li key={s.title} className="login__loop-step">
                  <span className="login__loop-icon" aria-hidden="true"><InfoIcon name={s.icon} size={18} /></span>
                  <span className="login__loop-text">
                    <strong>{s.title}</strong>
                    <span>{s.desc}</span>
                  </span>
                  {i < L.loop.length - 1 && <span className="login__loop-arrow" aria-hidden="true">→</span>}
                </li>
              ))}
            </ol>
            <p className="login__loop-note">{L.loopNote}</p>
          </section>

          {/* 功能卡片 */}
          <ul className="login__cards">
            {L.features.map((f) => (
              <li key={f.title} className="login__feature-card">
                <span className="login__feature-icon" aria-hidden="true"><InfoIcon name={f.icon} size={18} /></span>
                <strong className="login__feature-title">{f.title}</strong>
                <span className="login__feature-desc">{f.desc}</span>
              </li>
            ))}
          </ul>

          {/* 支援的執行環境 */}
          <section aria-label={L.runtimesTitle}>
            <h3 className="login__section-title">{L.runtimesTitle}</h3>
            <ul className="login__chips">
              {L.runtimes.map((r) => (
                <li key={r.name} className="login__chip">
                  <InfoIcon name={r.icon} size={14} />
                  <span>{r.name}</span>
                </li>
              ))}
            </ul>
          </section>

          <p className="login__foot">
            <InfoIcon name="cloud" size={14} />
            <span>{L.foot}</span>
          </p>
        </div>
      </aside>

      {/* 右側:登入表單 */}
      <main className="login__panel" role="main">
        <div className="login__panel-top">
          <LanguageSelect className="login__lang" />
        </div>

        <form
          className="login__card"
          onSubmit={onSubmit}
          aria-labelledby="login-title"
        >
          {/* 小螢幕(介紹區隱藏時)也看得到品牌名 */}
          <div className="login__card-brand">
            <span className="login__logo">▸</span>
            <span className="login__brand-name">{t('app.name')}</span>
          </div>
          <h1 id="login-title" className="login__title">
            {t('auth.welcome')}
          </h1>

          {!configured && (
            <p className="login__notice" role="status">
              {t('auth.notConfigured')}
            </p>
          )}

          {/* 社群登入(預留):先 disabled + 即將推出 */}
          <div className="login__social">
            {SOCIAL_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="login__social-btn"
                disabled
                title={t('auth.comingSoon')}
                aria-label={`${t(p.labelKey)} (${t('auth.comingSoon')})`}
              >
                <span className="login__social-glyph" aria-hidden="true">
                  {p.glyph}
                </span>
                <span>{t(p.labelKey)}</span>
                <span className="login__badge">{t('auth.comingSoon')}</span>
              </button>
            ))}
          </div>

          <div className="login__divider">
            <span>{t('auth.orDivider')}</span>
          </div>

          <label className="login__field">
            <span className="login__label">{t('auth.email')}</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting || !configured}
            />
          </label>

          <label className="login__field">
            <span className="login__label">{t('auth.password')}</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting || !configured}
            />
          </label>

          {error && (
            <p className="login__error" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="login__submit"
            disabled={submitting || !configured}
          >
            {submitting ? t('auth.signingIn') : t('auth.submit')}
          </button>
        </form>
      </main>
    </div>
  );
}
