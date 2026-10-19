/**
 * 內建類型樣板的顯示名稱與說明(五語系)。
 *
 * 為什麼放在前端:內建知識庫的 name / description 由後端 `builtinKnowledgeBases.ts` 的
 * BUILTIN_DEFS 以單一繁中字串提供(同一份定義還含餵給 agent 的 markdown 知識),所以不論
 * 介面語系是日文或英文,知識庫頁的樣板卡片都印繁中 —— 使用者實際回報的問題。
 *
 * 後端那份定義是 agent 知識的真相源,動它會改變模型讀到的內容;顯示文字與 agent 知識
 * 本來就是兩件事,因此這裡只處理「給人看的那兩個欄位」,後端完全不動。
 *
 * 名稱不在這裡:genre 的顯示名稱已經有 i18n key(`genre.<genre>`,五語系齊全),
 * 直接用 `t(genreLabelKey(genre))` 即可,不要再維護第二份。
 */

/** [繁中, English, 简中, 日本語, 한국어] */
type L5 = readonly [string, string, string, string, string];
const IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };

const DESC: Record<string, L5> = {
  slot: [
    '轉軸、下注、Spin、免費遊戲與 RTP 等 Slot 通用概念與測試要點。',
    'Reels, bets, spins, free games and RTP — the shared concepts and test points for slots.',
    '转轴、下注、Spin、免费游戏与 RTP 等 Slot 通用概念与测试要点。',
    'リール・ベット・スピン・フリーゲーム・RTP など、スロット共通の概念とテスト観点。',
    '릴, 베팅, 스핀, 프리 게임, RTP 등 슬롯 공통 개념과 테스트 포인트.',
  ],
  rpg: [
    '角色、關卡、戰鬥、背包與任務等 RPG 通用流程與測試要點。',
    'Characters, stages, battles, inventory and quests — the shared flows and test points for RPGs.',
    '角色、关卡、战斗、背包与任务等 RPG 通用流程与测试要点。',
    'キャラクター・ステージ・戦闘・インベントリ・クエストなど、RPG 共通のフローとテスト観点。',
    '캐릭터, 스테이지, 전투, 인벤토리, 퀘스트 등 RPG 공통 흐름과 테스트 포인트.',
  ],
  mmorpg: [
    '角色創建、開放世界、組隊、副本與社交等 MMORPG 通用流程與測試要點。',
    'Character creation, open world, parties, dungeons and social features — the shared flows and test points for MMORPGs.',
    '角色创建、开放世界、组队、副本与社交等 MMORPG 通用流程与测试要点。',
    'キャラクター作成・オープンワールド・パーティ・ダンジョン・ソーシャルなど、MMORPG 共通のフローとテスト観点。',
    '캐릭터 생성, 오픈 월드, 파티, 던전, 소셜 등 MMORPG 공통 흐름과 테스트 포인트.',
  ],
  puzzle: [
    '棋盤、消除、關卡目標與步數等 Match-3/解謎通用概念與測試要點。',
    'Boards, matching, stage goals and move limits — the shared concepts and test points for match-3 and puzzle games.',
    '棋盘、消除、关卡目标与步数等 Match-3/解谜通用概念与测试要点。',
    'ボード・マッチ消し・ステージ目標・手数など、マッチ3/パズル共通の概念とテスト観点。',
    '보드, 매칭 제거, 스테이지 목표, 이동 횟수 등 매치3/퍼즐 공통 개념과 테스트 포인트.',
  ],
  card: [
    '牌組、抽牌、費用、回合與對戰等卡牌遊戲通用概念與測試要點。',
    'Decks, draws, costs, turns and matches — the shared concepts and test points for card games.',
    '牌组、抽牌、费用、回合与对战等卡牌游戏通用概念与测试要点。',
    'デッキ・ドロー・コスト・ターン・対戦など、カードゲーム共通の概念とテスト観点。',
    '덱, 드로우, 비용, 턴, 대전 등 카드 게임 공통 개념과 테스트 포인트.',
  ],
  action: [
    '即時操作、關卡、連段與生命值等動作遊戲通用概念與測試要點。',
    'Real-time controls, stages, combos and health — the shared concepts and test points for action games.',
    '即时操作、关卡、连段与生命值等动作游戏通用概念与测试要点。',
    'リアルタイム操作・ステージ・コンボ・体力など、アクションゲーム共通の概念とテスト観点。',
    '실시간 조작, 스테이지, 콤보, 체력 등 액션 게임 공통 개념과 테스트 포인트.',
  ],
  adventure: [
    '探索、劇情、物品與解謎等冒險遊戲通用概念與測試要點。',
    'Exploration, story, items and puzzles — the shared concepts and test points for adventure games.',
    '探索、剧情、物品与解谜等冒险游戏通用概念与测试要点。',
    '探索・ストーリー・アイテム・謎解きなど、アドベンチャーゲーム共通の概念とテスト観点。',
    '탐험, 스토리, 아이템, 퍼즐 등 어드벤처 게임 공통 개념과 테스트 포인트.',
  ],
  action_adventure: [
    '結合即時戰鬥與探索/劇情的動作冒險遊戲通用概念與測試要點。',
    'Real-time combat combined with exploration and story — the shared concepts and test points for action-adventure games.',
    '结合即时战斗与探索/剧情的动作冒险游戏通用概念与测试要点。',
    'リアルタイム戦闘と探索/ストーリーを組み合わせたアクションアドベンチャー共通の概念とテスト観点。',
    '실시간 전투와 탐험/스토리가 결합된 액션 어드벤처 공통 개념과 테스트 포인트.',
  ],
  strategy: [
    '資源、建造、單位與回合/即時對戰等策略遊戲通用概念與測試要點。',
    'Resources, building, units and turn-based or real-time battles — the shared concepts and test points for strategy games.',
    '资源、建造、单位与回合/即时对战等策略游戏通用概念与测试要点。',
    '資源・建設・ユニット・ターン制/リアルタイム対戦など、ストラテジー共通の概念とテスト観点。',
    '자원, 건설, 유닛, 턴제/실시간 대전 등 전략 게임 공통 개념과 테스트 포인트.',
  ],
  simulation: [
    '建設、生產鏈、資源循環與經營等模擬遊戲通用概念與測試要點。',
    'Building, production chains, resource loops and management — the shared concepts and test points for simulation games.',
    '建设、生产链、资源循环与经营等模拟游戏通用概念与测试要点。',
    '建設・生産チェーン・資源循環・経営など、シミュレーション共通の概念とテスト観点。',
    '건설, 생산 체인, 자원 순환, 경영 등 시뮬레이션 공통 개념과 테스트 포인트.',
  ],
  shooter: [
    '瞄準、射擊、彈藥與敵人等射擊遊戲(FPS/TPS/彈幕)通用概念與測試要點。',
    'Aiming, shooting, ammo and enemies — the shared concepts and test points for shooters (FPS, TPS, bullet-hell).',
    '瞄准、射击、弹药与敌人等射击游戏(FPS/TPS/弹幕)通用概念与测试要点。',
    'エイム・射撃・弾薬・敵など、シューティング(FPS/TPS/弾幕)共通の概念とテスト観点。',
    '조준, 사격, 탄약, 적 등 슈팅 게임(FPS/TPS/탄막) 공통 개념과 테스트 포인트.',
  ],
  fighting: [
    '對戰、連段、血條與角色選擇等格鬥遊戲通用概念與測試要點。',
    'Matches, combos, health bars and character select — the shared concepts and test points for fighting games.',
    '对战、连段、血条与角色选择等格斗游戏通用概念与测试要点。',
    '対戦・コンボ・体力ゲージ・キャラ選択など、格闘ゲーム共通の概念とテスト観点。',
    '대전, 콤보, 체력 바, 캐릭터 선택 등 격투 게임 공통 개념과 테스트 포인트.',
  ],
  platformer: [
    '跳躍、平台、關卡與收集等平台遊戲通用概念與測試要點。',
    'Jumping, platforms, stages and collectibles — the shared concepts and test points for platformers.',
    '跳跃、平台、关卡与收集等平台游戏通用概念与测试要点。',
    'ジャンプ・プラットフォーム・ステージ・収集など、プラットフォーマー共通の概念とテスト観点。',
    '점프, 플랫폼, 스테이지, 수집 등 플랫포머 공통 개념과 테스트 포인트.',
  ],
  racing: [
    '賽道、車輛操控、圈數與名次等競速遊戲通用概念與測試要點。',
    'Tracks, vehicle handling, laps and placement — the shared concepts and test points for racing games.',
    '赛道、车辆操控、圈数与名次等竞速游戏通用概念与测试要点。',
    'コース・車両操作・ラップ・順位など、レーシング共通の概念とテスト観点。',
    '트랙, 차량 조작, 랩, 순위 등 레이싱 게임 공통 개념과 테스트 포인트.',
  ],
  sports: [
    '球類/運動規則、比分與操作等運動遊戲通用概念與測試要點。',
    'Sport rules, scores and controls — the shared concepts and test points for sports games.',
    '球类/运动规则、比分与操作等运动游戏通用概念与测试要点。',
    '競技ルール・スコア・操作など、スポーツゲーム共通の概念とテスト観点。',
    '종목 규칙, 점수, 조작 등 스포츠 게임 공통 개념과 테스트 포인트.',
  ],
  board: [
    '棋盤、回合、規則與勝負判定等桌遊/棋牌通用概念與測試要點。',
    'Boards, turns, rules and win conditions — the shared concepts and test points for board and tabletop games.',
    '棋盘、回合、规则与胜负判定等桌游/棋牌通用概念与测试要点。',
    'ボード・ターン・ルール・勝敗判定など、ボードゲーム共通の概念とテスト観点。',
    '보드, 턴, 규칙, 승패 판정 등 보드게임 공통 개념과 테스트 포인트.',
  ],
  rhythm: [
    '節拍、判定、譜面與分數等音樂遊戲通用概念與測試要點。',
    'Beats, timing judgement, charts and scoring — the shared concepts and test points for rhythm games.',
    '节拍、判定、谱面与分数等音乐游戏通用概念与测试要点。',
    'ビート・判定・譜面・スコアなど、音楽ゲーム共通の概念とテスト観点。',
    '비트, 판정, 노트 차트, 점수 등 리듬 게임 공통 개념과 테스트 포인트.',
  ],
  survival: [
    '資源採集、製作、飢餓/生命與威脅等生存遊戲通用概念與測試要點。',
    'Gathering, crafting, hunger and health, and threats — the shared concepts and test points for survival games.',
    '资源采集、制作、饥饿/生命与威胁等生存游戏通用概念与测试要点。',
    '資源採集・クラフト・空腹/体力・脅威など、サバイバル共通の概念とテスト観点。',
    '자원 채집, 제작, 허기/체력, 위협 등 서바이벌 공통 개념과 테스트 포인트.',
  ],
  roguelike: [
    '隨機生成、單局(Run)、永久死亡與 build 等 Roguelike 通用概念與測試要點。',
    'Procedural generation, runs, permadeath and builds — the shared concepts and test points for roguelikes.',
    '随机生成、单局(Run)、永久死亡与 build 等 Roguelike 通用概念与测试要点。',
    'ランダム生成・ラン・パーマデス・ビルドなど、ローグライク共通の概念とテスト観点。',
    '무작위 생성, 런, 영구 죽음, 빌드 등 로그라이크 공통 개념과 테스트 포인트.',
  ],
  battle_royale: [
    '空降、搜刮、縮圈與最後生還等大逃殺通用概念與測試要點。',
    'Drops, looting, the shrinking zone and last-one-standing — the shared concepts and test points for battle royale games.',
    '空降、搜刮、缩圈与最后生还等大逃杀通用概念与测试要点。',
    '降下・物資収集・エリア縮小・最後の生存者など、バトルロイヤル共通の概念とテスト観点。',
    '강하, 파밍, 자기장 축소, 최후 생존 등 배틀로얄 공통 개념과 테스트 포인트.',
  ],
  sandbox: [
    '自由探索、建造與多系統並存等沙盒/開放世界通用概念與測試要點。',
    'Free exploration, building and many coexisting systems — the shared concepts and test points for sandbox and open-world games.',
    '自由探索、建造与多系统并存等沙盒/开放世界通用概念与测试要点。',
    '自由探索・建築・複数システムの共存など、サンドボックス/オープンワールド共通の概念とテスト観点。',
    '자유 탐험, 건축, 다중 시스템 공존 등 샌드박스/오픈월드 공통 개념과 테스트 포인트.',
  ],
  idle: [
    '自動產出、離線收益與升級等放置(Idle/Clicker)遊戲通用概念與測試要點。',
    'Automatic output, offline earnings and upgrades — the shared concepts and test points for idle and clicker games.',
    '自动产出、离线收益与升级等放置(Idle/Clicker)游戏通用概念与测试要点。',
    '自動生産・オフライン収益・アップグレードなど、放置(Idle/Clicker)共通の概念とテスト観点。',
    '자동 생산, 오프라인 수익, 업그레이드 등 방치형(Idle/Clicker) 공통 개념과 테스트 포인트.',
  ],
  moba: [
    '英雄、兵線、技能與推塔等 MOBA 通用概念與測試要點。',
    'Heroes, lanes, abilities and pushing towers — the shared concepts and test points for MOBAs.',
    '英雄、兵线、技能与推塔等 MOBA 通用概念与测试要点。',
    'ヒーロー・レーン・スキル・タワー攻めなど、MOBA 共通の概念とテスト観点。',
    '영웅, 라인, 스킬, 타워 공략 등 MOBA 공통 개념과 테스트 포인트.',
  ],
  casino: [
    '多種博弈玩法(輪盤/21點/骰寶等)、下注與派彩等 Casino 通用概念與測試要點。',
    'Multiple casino games (roulette, blackjack, sic bo…), betting and payouts — the shared concepts and test points.',
    '多种博弈玩法(轮盘/21点/骰宝等)、下注与派彩等 Casino 通用概念与测试要点。',
    '複数のカジノゲーム(ルーレット/ブラックジャック/大小など)・ベット・払い出しなど、カジノ共通の概念とテスト観点。',
    '여러 카지노 게임(룰렛/블랙잭/식보 등), 베팅, 배당 등 카지노 공통 개념과 테스트 포인트.',
  ],
  bingo: [
    '卡片、開球、標記與連線等賓果遊戲通用概念與測試要點。',
    'Cards, ball draws, marking and lines — the shared concepts and test points for bingo games.',
    '卡片、开球、标记与连线等宾果游戏通用概念与测试要点。',
    'カード・抽球・マーク・ライン成立など、ビンゴ共通の概念とテスト観点。',
    '카드, 볼 추첨, 마킹, 라인 완성 등 빙고 공통 개념과 테스트 포인트.',
  ],
  casual: [
    '簡單易上手、短局與輕度目標等休閒遊戲通用概念與測試要點。',
    'Easy to pick up, short sessions and light goals — the shared concepts and test points for casual games.',
    '简单易上手、短局与轻度目标等休闲游戏通用概念与测试要点。',
    '手軽・短時間プレイ・軽い目標など、カジュアルゲーム共通の概念とテスト観点。',
    '쉬운 진입, 짧은 플레이, 가벼운 목표 등 캐주얼 게임 공통 개념과 테스트 포인트.',
  ],
  hyper_casual: [
    '單一機制、極簡操作與快速重玩等超休閒遊戲通用概念與測試要點。',
    'A single mechanic, minimal controls and instant replays — the shared concepts and test points for hyper-casual games.',
    '单一机制、极简操作与快速重玩等超休闲游戏通用概念与测试要点。',
    '単一メカニクス・極小操作・即リトライなど、ハイパーカジュアル共通の概念とテスト観点。',
    '단일 메커닉, 최소 조작, 즉시 재시작 등 하이퍼 캐주얼 공통 개념과 테스트 포인트.',
  ],
  educational: [
    '題目、互動教學與獎勵回饋等教育遊戲通用概念與測試要點。',
    'Questions, interactive teaching and reward feedback — the shared concepts and test points for educational games.',
    '题目、互动教学与奖励回馈等教育游戏通用概念与测试要点。',
    '問題・インタラクティブな学習・報酬フィードバックなど、教育ゲーム共通の概念とテスト観点。',
    '문제, 인터랙티브 학습, 보상 피드백 등 교육 게임 공통 개념과 테스트 포인트.',
  ],
  tower_defense: [
    '路徑、防禦塔、波次與資源等塔防通用概念與測試要點。',
    'Paths, towers, waves and resources — the shared concepts and test points for tower defence games.',
    '路径、防御塔、波次与资源等塔防通用概念与测试要点。',
    'ルート・タワー・ウェーブ・資源など、タワーディフェンス共通の概念とテスト観点。',
    '경로, 타워, 웨이브, 자원 등 타워 디펜스 공통 개념과 테스트 포인트.',
  ],
  survivor: [
    '虛擬搖桿走位、移動即戰鬥、自動攻擊、撐時間存活與升級等「割草」類遊戲通用概念與測試要點。',
    'Virtual-stick movement as the core action, auto-attacks, surviving the clock and levelling up — the shared concepts and test points for survivor-like games.',
    '虚拟摇杆走位、移动即战斗、自动攻击、撑时间存活与升级等「割草」类游戏通用概念与测试要点。',
    'バーチャルスティックでの移動が戦闘そのもの、オート攻撃、時間を耐えて生き残る、レベルアップなど、ヴァンサバ系共通の概念とテスト観点。',
    '가상 스틱 이동이 곧 전투, 자동 공격, 시간 버티기 생존, 레벨업 등 뱀서라이크 공통 개념과 테스트 포인트.',
  ],
  other: [
    '未分類或跨類型 App 的通用探索與測試要點。',
    'General exploration and test points for uncategorised or cross-genre apps.',
    '未分类或跨类型 App 的通用探索与测试要点。',
    '未分類またはジャンル横断の App 向けの汎用的な探索とテスト観点。',
    '미분류 또는 장르 혼합 앱을 위한 일반 탐색 및 테스트 포인트.',
  ],
};

/**
 * 內建類型樣板的說明(依介面語系)。認不出 genre 就回 undefined,
 * 呼叫端退回後端給的字(新增 genre 時不會變成空白)。
 */
export function builtinKbDescription(genre: string | undefined, locale: string): string | undefined {
  if (!genre) return undefined;
  const v = DESC[genre];
  if (!v) return undefined;
  return v[IDX[locale] ?? 1] ?? v[1];
}

/** 內建知識庫 id(`kb-builtin-<genre>`)→ genre;不是內建的回 undefined。 */
export function genreFromBuiltinKbId(id: string | undefined): string | undefined {
  const m = /^kb-builtin-(.+)$/.exec(String(id ?? ''));
  return m ? m[1] : undefined;
}
