import type { GuideContent } from '../guideContent.ts';
/** 使用说明(简体中文)。来源:guideContent.ts 的 zhHant;修改功能时请同步。 */
export const zhHans: GuideContent = {
  heroTitle: '使用说明',
  heroLead:
    '本说明分为四部分:系统用途、操作流程、系统架构,以及技术术语、模型、费用与各功能的详细操作。',
  purposeTitle: '系统用途',
  purposeBody:
    'AI 驱动的游戏/App 自动化测试平台。你用大白话描述要测试的流程,AI 就会自己看画面、点击操作、判断成败,并生成带截图的多语言报告。',
  flowTitle: '技术架构说明',
  flowLead:
    '从上传产物到拿到报告的完整流程如下。核心是先让 Agent 自主探索、构建记忆地图,再据此生成测试场景模板。第六步“挂载知识库”是可选的。',
  archTitle: '系统架构说明',
  archLead:
    '这是实际部署在 AWS us-east-2 的云端架构。每个方框都标注了对应的 AWS 服务;绿框=已端到端验证,橙色虚线框=已有代码骨架但尚未端到端验证。连线颜色代表数据流类型(见图下方图例)。所有执行资源都是“有任务才启动、结束即关闭”,没有常驻主机。',
  flow: [
    { label: '① 产物获取', desc: '上传被测 App(APK/IPA/XAPK/ZIP/EXE)或配置 Web 网址,填写类型、版本、标识符。' },
    { label: '② 自主探索', desc: '根据应用类型,Agent 自主游玩、遍历可达画面,收集画面与跳转。' },
    { label: '③ 记忆地图', desc: '把探索得到的画面节点与操作跳转汇总成一张导航记忆地图。' },
    { label: '④ 场景模板', desc: '根据记忆地图上的可达路径,自动生成测试场景模板供挑选。' },
    { label: '⑤ AI 编辑模板', desc: '用自然语言微调模板,AI 生成可执行的 YAML 用例。' },
    { label: '⑥ 知识库', desc: '(可选)挂载内置游戏类型知识,或自建专属知识(Markdown / PDF 检索)。' },
    { label: '⑦ 创建任务', desc: '选择执行环境、模型与知识库,提交到云端队列执行。' },
    { label: '⑧ Agent 执行', desc: '截图 → VLM 定位坐标 → Agent 决策 → 执行操作 → 再截图,循环往复并回馈记忆地图。' },
    { label: '⑨ 生成报告', desc: '按类型生成包含截图、逐步轨迹、成本与导航图的多语言报告。' },
  ],
  sections: [
    {
      id: 'quickstart',
      title: '快速开始:第一次跑测试',
      intro: '首次使用时按以下五步操作,大约 10 分钟就能看到第一份报告。',
      steps: [
        { title: '1. 创建应用', body: '顶部“应用管理”→“创建应用”,填写名称、平台、游戏类型,上传安装包(Web 则填写网址)。' },
        { title: '2. 配置测试凭据(需要登录时才填)', body: '进入应用工作区 →“测试凭据”标签页,把账号、密码等按每个字段一行填写。不需要登录的游戏可以跳过。' },
        { title: '3. 编写测试用例', body: '“测试用例”标签页 → 用大白话描述流程(例如“用游客登录,进入老虎机,连续转 10 次”)→“用 AI 起草”→ 检查后保存。' },
        { title: '4. 提交任务', body: '“测试任务”标签页 → 选择用例与执行环境。首次建议使用默认模型,并把“步数上限”设为 50~100,以免意外花费过多。' },
        { title: '5. 查看结果', body: '任务详情页可实时查看画面与 AI 的思考过程;结束后点击“查看报告”查看判定、截图与花费。' },
      ],
    },
    {
      id: 'runtimes',
      title: '如何选择执行环境',
      intro: '提交任务时需要选择“在哪里运行”。每种环境都是有任务才启动、结束即关闭,只在执行期间计费。',
      steps: [
        { title: 'Web 浏览器', body: '云端无头 Chromium(Playwright)。用于网页游戏或网站,启动最快、最便宜(约每小时 US$0.05)。' },
        { title: 'Android 真机(Device Farm)', body: 'AWS Device Farm 的实体手机。最接近玩家的真实环境,支持录屏与音效判断,游戏不会检测到模拟器。每台每分钟 US$0.17;单次连接最长 150 分钟(AWS 限制),开机约 3~5 分钟。可指定机型,或保留“自动”选择第一台可用设备。' },
        { title: 'Android 真机・长时', body: '用于超过 150 分钟的测试。系统每 140 分钟切换一条新连接,切换时游戏会重启,因此测试脚本需要能自己回到测试点。' },
        { title: 'iOS 真机(Device Farm)', body: '需要可安装的 .ipa 文件。单次连接最长 150 分钟,录屏没有声音。' },
        { title: 'Android 容器(Redroid)', body: '每个任务启动一台 ARM 云主机运行 Android 容器(约每小时 US$0.17),可运行 1~72 小时,也适合大规模并行。限制:带反模拟器检测的游戏会自行关闭(例如嘎嘎特攻),这类游戏请改用真机;没有录屏与音效判断;不支持双指缩放。' },
        { title: 'Windows PC 游戏(GameLift Streams)', body: '云端 NVIDIA GPU 主机,需要管理员先完成一次性配置才会出现。单次最长 60 分钟;分辨率总像素最多 1920×1080(竖屏最多 1080×1920);首次启动约 10~15 分钟。' },
        { title: '如何判断', body: '一般手游先用 Android 容器(便宜、可长时间运行);游戏一打开就闪退,或需要验证音效、录屏时,改用真机;网页游戏用 Web。' },
      ],
    },
    {
      id: 'apps',
      title: '应用管理',
      intro: '被测游戏/App 的入口。每款 App 是一个工作区,集中存放它的测试用例、任务、报告、记忆地图与测试凭据。',
      steps: [
        { title: '创建应用', body: '点击“创建应用”,填写名称、平台、游戏类型;Android/iOS/Windows 需上传安装包(APK、XAPK、IPA、ZIP 或 EXE),Web 填写网址即可。可上传图标。' },
        { title: '游戏类型', body: '选择主类型(Slot、MMORPG、RPG、休闲等)与次要类型。系统会根据类型自动挂载对应的内置知识库,报告也会套用该类型的判定规范。' },
        { title: '标识符', body: 'Android 填写包名(例如 com.example.game)。系统用它在设备上启动与检测 App,也用于过滤设备日志。' },
        { title: '版本', body: '同一款 App 可上传多个版本,提交任务时选择要测试的版本;报告会记录测试的是哪个版本,方便对比不同版本的结果。' },
        { title: '进入工作区', body: '点击卡片或“进入工作区”,通过标签页切换这款游戏的用例、任务、报告、记忆地图与测试凭据。' },
      ],
    },
    {
      id: 'credentials',
      title: '测试凭据(账号密码)',
      intro: '需要登录、注册或选择服务器的流程,把账号密码保存在这里,AI 遇到表单时会自动填写,用例里无需填写。',
      steps: [
        { title: '新增字段', body: '应用工作区 →“测试凭据”→ 每个字段一行,例如“账号”、“密码”、“服务器名称”。字段名可以使用中文。' },
        { title: '脱敏(默认)', body: '账号密码这类机密信息请使用脱敏。AI 永远看不到值,只知道存在这个字段,输入时键入 ${账号},由执行端在输入时替换为真实的值。' },
        { title: '对 AI 可见', body: '仅用于“AI 必须从列表中选出”且不敏感的值,例如服务器名称。可见的值会进入 AI 的上下文。' },
        { title: '安全性', body: '值只保存在 AWS Secrets Manager。脱敏值不会出现在界面、API 响应、模型提示词、S3、报告或执行轨迹中;每个租户的每个 App 只能读取自己的凭据。在用例中直接写密码会被系统拦截。' },
      ],
    },
    {
      id: 'cases',
      title: '测试用例',
      intro: '一个用例 = 一段让 AI 执行的测试流程,加上用于判定成败的条件(assertions)。',
      steps: [
        { title: '用 AI 起草', body: '用大白话描述流程,点击“用 AI 起草”,系统用 Claude Sonnet 4.5 生成 YAML 草稿(含步骤与判定条件),你审阅修改后保存。' },
        { title: '编写好用例的技巧', body: '写清楚起点、要做的事和完成条件,例如“用游客 Play now 进入 → 关闭所有弹窗 → 进入 Slots 任意一台 → 连续转 10 次”。次数、金额这类数字要写明确,AI 才知道什么时候算完成。' },
        { title: '从表格导入', body: '已有 Excel 测试清单时可直接导入:系统会读取表格布局,拆分为每行一个用例,导入前可逐行修改,也可整份导入为一个测试套件。' },
        { title: '版本', body: '每次修改都会保留一个用例版本。提交任务时默认使用当前版本,也可以指定旧版本重跑。' },
        { title: '密钥边界', body: '用例中不可写明文密码;需要登录时请使用“测试凭据”,系统会拦截明文密钥。' },
      ],
    },
    {
      id: 'tasks',
      title: '测试任务',
      intro: '把某个用例提交去实际执行,并在执行中实时监控与干预。',
      steps: [
        { title: '提交', body: '选择用例、执行环境(见上方“如何选择执行环境”)以及要测试的版本。Device Farm 可指定机型;Android 容器与 Windows 可选择最长执行时长;Windows 可选择分辨率。' },
        { title: '模型', body: '三个座位可各自更换模型,默认为决策 Nova Lite、画面分析 Kimi K3、辅助 Nova Micro。下拉菜单会标注价格与推荐星标。UI-TARS 只有在管理员开启时才会出现。' },
        { title: '上限', body: '建议同时设置“步数上限”与“预算上限”。花费达到预算即停止(状态 budget_exceeded);不设置表示没有上限。' },
        { title: '知识库', body: '可多选知识库(例如 Slot + RTP)。App 的默认知识库与类型内置知识会自动带入。' },
        { title: '实时画面', body: '任务详情页上方的时间轴显示开机各阶段及耗时。启动完成后可查看实时画面,点击画面可在新窗口中放大(适合双屏)。' },
        { title: '给 AI 下指令', body: '执行中可以输入文字告诉 AI 该怎么做,或直接在画面上点一个位置并点击“让 AI 点这里”。勾选“记住”会把这条提示保存到这款 App 的记忆中,之后的任务也会用到。' },
        { title: '右侧日志', body: '标签页切换:设备日志(真机与 Android 容器的 logcat,闪退原因看这里)、音效、视觉/决策/辅助 Agent 每一步的输入输出、实时分析,以及各模型的 token 用量。' },
        { title: '取消与删除', body: '进行中的任务可以取消(会停止计费);已结束的任务记录可以删除。' },
      ],
    },
    {
      id: 'reports',
      title: '测试报告',
      intro: '任务结束后的产出,只读。内容按游戏类型的报告规范整理。',
      steps: [
        { title: '判定', body: '每个判定条件各自标记通过或失败,并附上证据截图与 AI 的理由。fail 通常是被测 App 或用例的问题;error 通常是环境或基础设施的问题。' },
        { title: '轨迹与截图', body: '逐步列出 AI 看到的画面、决定的动作与结果。真机任务有全程录屏(含声音),点击某一步可直接跳到对应片段。' },
        { title: '导航图', body: '本次经过的画面与跳转,同时会累积到记忆地图中。' },
        { title: '成本', body: '显示预算上限、实际花费与各模型的 token 用量。' },
        { title: '多语言', body: '报告中的 AI 描述可切换语言。' },
      ],
    },
    {
      id: 'memory',
      title: '记忆地图',
      intro: '跨多次测试累积的 App 全景:AI 走过的画面成为节点、操作跳转成为连线,帮助后续测试更快到达目标。测试人员在任务中“记住”的提示也保存在这里。可以清除某款 App 的记忆重新累积。',
    },
    {
      id: 'knowledge',
      title: '知识管理',
      intro:
        '可复用的知识库,所有登录用户共享。分两种:游戏类别型(如 Slot)与场景型(如 RTP)。每个知识库可存放两种知识:',
      steps: [
        { title: '内置知识库', body: '系统内置各游戏类型的知识(例如 Slot、Casino、大逃杀)。需要定制时可以复制一份修改,之后就用你的版本替代内置版本,不会重复注入。' },
        { title: 'Markdown 知识', body: '在网页上直接编辑的 Markdown,执行时整份注入 AI,适合“少量确定的事实、术语、判读规则”。' },
        { title: 'PDF/文档检索', body: '创建时勾选“启用文档检索”会创建云端向量知识库,可上传 PDF、攻略、策划案,点击“同步”后 AI 执行时会按任务目标检索相关片段,适合“大量参考资料”。' },
        { title: '测试时多选', body: '创建测试时多选要用的知识库,两层(通用类别 + 特定场景)可叠加。App 也可设置默认知识库。正在被 App 或用例使用的知识库不能直接删除。' },
      ],
    },
    {
      id: 'devices',
      title: '设备管理',
      intro: '查看当前有哪些执行资源。执行容器与主机都在任务提交时自动创建、结束时自动回收,无需手动管理。',
      steps: [
        { title: '云端真机', body: 'Device Farm 当前可用的实体手机列表(机型、系统版本、分辨率、内存、CPU)。' },
        { title: '容器 / 主机 / 串流', body: '正在运行的 Fargate 容器、Android 容器主机(EC2),以及 Windows 串流容量。忘记取消的长时间任务可以在这里发现。' },
      ],
    },
    {
      id: 'cost',
      title: '费用分析',
      intro: '两种数字并列显示,口径不同,不要相互抵减。',
      steps: [
        { title: '任务估算', body: '每次任务的模型 token × 单价,加上 Device Farm 实际计量分钟 × US$0.17,按天、按 App、按模型统计。打开即可使用。' },
        { title: 'AWS 实际账单', body: '从 AWS Cost Explorer 读取,包含所有基础设施。需要账号所有者先启用 Cost Explorer 与成本分配标签,数据约延迟 24 小时,每次查询 AWS 收费约 US$0.01。' },
      ],
    },
    {
      id: 'members',
      title: '成员管理(管理员)',
      intro: '仅管理员可见。系统不开放自助注册,所有账号都在这里创建。',
      steps: [
        { title: '新增成员', body: '填写 email、初始密码与租户(tenant)。租户决定此人能看到哪一份数据,不同租户的数据相互隔离。可以直接设为管理员。' },
        { title: '管理', body: '可重置密码、停用/启用、移到其他租户、授予或取消管理员、删除。系统会拦截会把自己锁在外面的操作(例如取消自己的管理员身份)。' },
        { title: '权限生效', body: '被设为管理员的人需要退出后重新登录,才能看到管理员页面。' },
      ],
    },
    {
      id: 'system',
      title: '系统管理(管理员)',
      intro: '平台自身的维护:从 GitHub 更新整个系统,以及开关 UI-TARS 定位模型。',
      steps: [
        { title: '系统更新', body: '页面会比对当前部署的版本与 GitHub 上的最新版本。点击“更新到…”并输入版本字符串确认后,云端会先运行测试,通过后才重新部署前端、API 与执行环境,约 5~15 分钟,可实时查看进度与日志。每次更新都会记录在更新历史中。' },
        { title: '更新注意事项', body: '此操作会以高权限重新部署整个平台,建议在没有任务执行时进行。要回退到旧版本,在输入框输入旧的 commit 或 tag 再更新一次即可。首次使用需先粘贴 GitHub token(只需 Contents 与 Metadata 只读权限)。' },
        { title: 'UI-TARS 开关', body: 'UI-TARS 是专门做 GUI 定位的模型,运行在 GPU 上,开启即计费(约每天 US$62.5,无论是否有任务),因此默认关闭。点击“开启”约 8~15 分钟后变为“已开启”,创建任务时的 VLM 菜单才会出现它;不用时点击“关闭”。目前只有 Device Farm 真机会用到。' },
      ],
    },
    {
      id: 'troubleshoot',
      title: '常见问题',
      intro: '遇到问题时先看这里。',
      steps: [
        { title: '游戏一打开就闪退(Android 容器)', body: '多半是游戏有反模拟器检测。打开任务的“设备日志”查看最后的错误,改用 Android 真机测试。' },
        { title: '画面一直不动,任务变为 error', body: '安装卡住、App 卡死或遇到验证码时,系统会先等待,画面长时间完全没有变化才结束任务,避免在计费的真机上空转。' },
        { title: '任务变为 budget_exceeded', body: '花费达到你设置的预算上限。调高预算或减少步数后重跑。' },
        { title: 'AI 一直点错位置', body: '在实时画面上点击正确位置并点击“让 AI 点这里”,同时勾选“记住”;或在用例中把按钮的位置与外观描述得更具体。仍然不准时,可请管理员临时开启 UI-TARS(真机任务)。' },
        { title: '菜单里没有 UI-TARS', body: '说明 UI-TARS 目前处于关闭状态,请管理员到“系统管理”开启。' },
        { title: '看不到成员管理 / 系统管理', body: '这两个页面只有管理员可见;如果刚被设为管理员,请退出后重新登录。' },
      ],
    },
  ],
  seatsTitle: '模型职责(三个 Seat)',
  seatsLead:
    '系统按“职责”把模型分为三个 Seat,而不是绑定某个供应商。每个 Seat 可独立选择模型,执行前会锁定单价快照(查不到价格则拒绝执行,绝不以未知成本启动)。',
  seats: [
    { seat: 'Agent(决策)', role: '主脑:查看当前画面与目标,决定下一步做什么(点哪里、输入什么、是否完成)。默认 Amazon Nova Lite。' },
    { seat: 'VLM(定位坐标)', role: '视觉:读取画面,把“要点击的东西”转换为画面上的实际坐标(x, y)。默认 Moonshot Kimi K3。' },
    { seat: 'Subagent(辅助)', role: '辅助:核对每一步是否生效、整理数据、核对是否真正完成(会拦截假完成),用便宜的模型节省成本。默认 Amazon Nova Micro。' },
  ],
  modelsTitle: '可用模型',
  modelsLead:
    '下表直接从后端获取完整的可用模型列表(随目录更新,不会过时)。具备视觉能力的模型才能担任 VLM(要看截图定位坐标),纯文本模型只担任 Agent/Subagent。默认组合为 Nova Lite / Kimi K3 / Nova Micro;UI-TARS(SageMaker GPU)只有在管理员于“系统管理”开启时才会列出。用户无需选择 SDK 或端点,系统根据 modelId 自动推导;非 Anthropic 模型的价格由 AWS Pricing API 获取并标注“估算”。',
  models: [
    { name: 'Amazon Nova Lite(默认决策)', modelId: 'us.amazon.nova-lite-v1:0', seat: 'Agent', price: '$0.066 / $0.264 每百万 token(估算)', note: '默认决策模型,便宜且够用。' },
    { name: 'Moonshot Kimi K3(默认画面分析)', modelId: 'us.moonshotai.kimi-k3', seat: 'VLM', price: '$3.63 / $18.15 每百万 token(估算)', note: '离线定位基准测试中像素误差最小。' },
    { name: 'Amazon Nova Micro(默认辅助)', modelId: 'us.amazon.nova-micro-v1:0', seat: 'Subagent', price: '$0.0385 / $0.154 每百万 token(估算)', note: '最省钱的辅助模型。' },
    { name: 'UI-TARS-1.5-7B(可选)', modelId: 'uitars', seat: 'VLM', price: 'GPU 开启即计费,约每天 US$62.5', note: '默认关闭,由管理员在系统管理中开启。' },
  ],
  modelsFootnote:
    '测试用例起草与表格导入使用 Claude Sonnet 4.5。知识库的 PDF 检索另用 Amazon Titan Text Embeddings v2(1024 维)生成向量,并以 Amazon Bedrock Knowledge Bases + S3 Vectors 存储与检索。',
  costTitle: '费用与成本护栏',
  costBody:
    '没有任务时,平台本身每月大约只需 US$2~5(主要是 S3 与镜像存储),因为没有常驻主机。费用主要来自执行期间:AI 模型 token(用默认模型跑一次 26 步、转 10 次的老虎机测试不到 US$0.80)、Device Farm 真机每分钟 US$0.17、Android 容器主机每小时约 US$0.17。唯一的大额可选费用是 UI-TARS GPU(开启约每天 US$62.5),默认关闭。每个任务可设置步数与预算上限;执行前先锁定各 Seat 的单价快照(查不到价格就拒绝执行),花费达到上限即停止,报告会显示实际花费与 token 用量。',
  detailsTitle: '技术术语、模型、费用与各功能操作',
  featuresTitle: '各功能操作',
  glossaryTitle: '技术术语',
  glossary: [
    { term: 'Seat(座位)', desc: '模型的“职责”而非供应商。分为 Agent(决策)、VLM(定位坐标)、Subagent(辅助)三种,可各自选择不同模型。' },
    { term: 'VLM', desc: 'Vision-Language Model,能同时看图和读文字的模型;负责把“要点击的东西”转换为画面上的实际坐标。' },
    { term: 'UI-TARS', desc: '专为 GUI 操作/坐标定位微调的视觉模型(ByteDance),部署在 SageMaker GPU 上。可选、默认关闭,由管理员在“系统管理”中开关;目前只有 Device Farm 真机会用到。' },
    { term: 'Redroid', desc: '在云端 ARM 主机上以容器方式运行的 Android,即“Android 容器”执行环境。' },
    { term: 'Device Farm', desc: 'AWS 的实体手机租用服务,按使用分钟计费,单次连接最长 150 分钟。' },
    { term: 'GameLift Streams', desc: 'AWS 的云端 GPU 串流服务,本系统用它运行 Windows PC 游戏,没有测试时不保留容量、不计费。' },
    { term: 'Agent 执行循环', desc: '截图 → VLM 定位坐标 → Agent 决策 → 执行动作 → 再截图,如此循环直到完成或停止。由云端的 Lambda 编排,执行端在 Fargate、EC2 或 GameLift Streams。' },
    { term: '坐标系(pixel / norm1000)', desc: '模型返回坐标的单位。有些模型返回像素,有些使用千分制(0–1000),系统会自动换算为实际像素。' },
    { term: '知识库(Markdown / 检索)', desc: 'Markdown 整份注入 AI(少量确定事实);PDF/文档则构建向量库,执行时按任务目标检索片段(大量资料)。' },
    { term: '租户(Tenant)', desc: '数据隔离单位。每个账号属于一个租户,只能看到自己租户的 App、用例、任务与报告。' },
    { term: 'Locality(运行地)', desc: '被测设备所在位置:cloud(云端提供)或 attached(你注册的本地设备,仍由云端大脑远程驱动)。' },
    { term: '终态', desc: '任务互斥的结束状态:pass(通过)/ fail(未通过)/ error(环境错误)/ cancelled(已取消)/ budget_exceeded(超出预算)/ dead(失联)。' },
    { term: 'Fail Closed', desc: '查不到某模型的单价时,在花任何钱之前直接拒绝执行,绝不以未知成本启动。' },
    { term: 'S3 Vectors', desc: 'Amazon Bedrock Knowledge Bases 的向量存储后端,搭配 Titan 文本嵌入进行文档检索。' },
  ],
};
