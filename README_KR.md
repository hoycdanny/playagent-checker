# PlayAgent Checker

**게임 / 앱을 위한 AI 기반 자동 QA 플랫폼.** 테스트할 흐름을 일상어로 설명하면 AI 에이전트가 화면을 보고 탭·스와이프를 대신 수행하며 성공/실패를 판정하고, 스크린샷·단계별 트레이스·내비게이션 맵이 포함된 다국어 리포트를 생성합니다.

> 언어: [English](README.md) · [繁體中文](README_ZH.md) · [简体中文](README_CN.md) · [日本語](README_JP.md) · **한국어**

---

## 개요

PlayAgent Checker는 **AWS(us-east-2)** 에서 동작하는 서버리스 컨트롤 플레인과 온디맨드 실행 러너로 구성됩니다. 앱을 업로드(또는 웹 URL 지정)하면 에이전트가 자율적으로 탐색하고, 재현 가능하고 검토 가능한 테스트 결과를 얻습니다.

- **실사용 가능한 두 가지 실행 백엔드(모두 엔드투엔드 검증 완료):**
  - **Web** — Playwright 기반 헤드리스 Chromium을 ECS Fargate에서 실행.
  - **Device Farm** — AWS Device Farm의 Android/iOS 실기기를 Fargate 러너에서 Appium으로 구동.
- **에이전트 루프:** 스크린샷 → VLM이 대상 좌표 측정 → Agent가 다음 동작 결정 → 기기에서 실행 → 다시 스크린샷, 을 목표 달성 또는 중지 조건까지 반복.
- **정확한 GUI 그라운딩:** 좌표 담당 VLM "시트"는 SageMaker에 배포한 **UI-TARS-1.5-7B**(GUI 그라운딩용 파인튜닝)를 사용할 수 있으며, 네이티브 요소가 없는 그래픽 위주 게임 화면에서 범용 비전 모델보다 훨씬 정확합니다.
- **지식 베이스:** 장르/시나리오 지식 연결(인라인 Markdown, 또는 Amazon Bedrock Knowledge Bases + S3 Vectors 기반 PDF/문서 검색).
- **비용 가드레일:** 각 작업은 실행 전 시트별 단가 스냅샷을 고정(가격 불명이면 실행 거부)하고 예산에 도달하면 중지.
- **다국어 UI 및 리포트:** 5개 로케일(zh-Hant, en, zh-Hans, ja, ko).

## 아키텍처 개요

```
브라우저(Web Console)
  → CloudFront + S3(정적 사이트)
  → API Gateway(+ Cognito JWT, IAM/STS 테넌트 격리)
  → Lambda API handler → SQS → Dispatcher Lambda → Engine Lambda(오케스트레이션)
        ├─ AI 브레인(Amazon Bedrock): Agent / VLM / SubAgent + 지식 베이스
        │     └─ VLM 좌표 측정은 Amazon SageMaker의 UI-TARS로 라우팅 가능
        └─ 기기 백엔드(ECS Fargate):
              ├─ Web    → Playwright headless Chromium
              └─ Device Farm → 실기기 + Appium
  → S3(스크린샷, 트레이스, 리포트, 메모리 맵)
  → EventBridge → WebSocket → 브라우저로 실시간 반영
```

Engine(Lambda)은 오케스트레이션만 담당합니다. 무거운 작업(대용량 APK 업로드, 기기 세션, 스크린샷→동작 루프)은 시간 제한이 없는 Fargate 컨테이너에서 실행됩니다. 자세한 내용은 [docs/architecture.md](docs/architecture.md) 참고.

## 저장소 구조

```
agent/            실행 러너(Fargate 컨테이너 내부에서 동작)
  explorationRunner.mjs   Device Farm 실기기 러너(Appium 루프)
  webExplorationRunner.mjs Web 러너(Playwright headless Chromium)
  appiumClient.mjs / playwrightClient.mjs  기기 드라이버
  imageTools.mjs          VLM용 smart-resize 및 탭 위치 주석
  uitarsClient.mjs        UI-TARS(SageMaker) 측위 클라이언트
  apkMerge.mjs            Device Farm용 XAPK / split-APK 병합
  sagemaker/              UI-TARS 배포: vLLM BYOC 컨테이너 + CodeBuild 스크립트
infra/            AWS CDK 앱(컨트롤 플레인, 실행, 스케줄링, 기반, 프런트엔드)
  lib/            CDK 스택
  lambda/         API, engine, dispatcher, WS 핸들러
  test/           CDK·단위 테스트
web/              React + Vite 웹 콘솔(5개 로케일 i18n, 자체 제작 SVG)
docs/             아키텍처, 설계 노트, 리서치
```

## 사전 요구 사항

- Node.js 22+
- **us-east-2** 자격 증명이 설정된 AWS 계정(Device Farm 프로젝트는 us-west-2에 있으며 러너가 관리)
- Docker(로컬 이미지 빌드 시에만 필요. 클라우드 빌드는 AWS CodeBuild 사용)
- AWS CDK v2(`npx cdk`)

## 시작하기

```bash
# 1. 설치
cd infra && npm install
cd ../web && npm install

# 2. 테스트
cd ../infra && npm test          # CDK·단위 테스트
cd ../web && npm run ci          # check:i18n + tsc + vitest + build

# 3. 배포(us-east-2)
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy --all --require-approval never
```

배포 후 웹 콘솔과 API URL이 스택 출력에 표시됩니다.

## 사용 흐름

1. **앱** — 앱 생성(이름, 플랫폼, 장르). 네이티브는 APK/IPA/ZIP 업로드, Web은 URL만.
2. **테스트 케이스** — 흐름을 일상어로 초안 작성(AI가 실행 가능한 YAML로 변환)하거나 YAML을 직접 작성. 시크릿은 `${ENV}` 플레이스홀더 사용, 리터럴 비밀번호는 거부됩니다.
3. **지식**(선택) — 장르/시나리오 지식 연결(Markdown은 전체 주입, PDF는 검색).
4. **작업** — 앱 + 케이스 + 실행 환경(Web 또는 Device Farm) + 좌표 모델 선택 후 제출. 실행 중 실시간 모니터링·취소 가능.
5. **리포트** — AI 설명, 단계 트레이스, 스크린샷, 내비게이션 그래프, 예산과 실제 비용 확인.

웹 콘솔의 **가이드** 페이지에 자세한 사용 설명이 있습니다.

## UI-TARS 그라운딩(선택, 고정밀)

범용 비전 모델은 그래픽 위주 게임 화면에서 정확한 픽셀 좌표를 내기 어렵습니다. GUI 그라운딩용으로 파인튜닝된 UI-TARS-1.5-7B는 훨씬 정확합니다. 사용하려면 SageMaker 엔드포인트를 배포합니다(빌드는 전부 클라우드에서 수행되어 로컬 디스크/대역폭을 소비하지 않음):

```bash
cd agent/sagemaker && npm install
# 클라우드 빌드: HF 다운로드 → S3 → vLLM 이미지 → ECR(CodeBuild 경유)
AWS_REGION=us-east-2 node cloudBuild.mjs
# 엔드포인트 생성(가중치·이미지는 이미 준비됨)
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
# 엔드포인트 이름을 engine에 연결
cd ../../infra && AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=<엔드포인트 이름>
```

> **비용 주의:** UI-TARS 엔드포인트는 `ml.g6e.xlarge`(약 US$1.86/시간)에서 동작하며 켜져 있는 동안 계속 과금됩니다. 사용하지 않을 때는 삭제하세요:
> ```bash
> node agent/sagemaker/teardownUitars.mjs <엔드포인트 이름>
> ```

설계는 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md) 참고.

## 문서

- [docs/architecture.md](docs/architecture.md) — 시스템 아키텍처, 데이터 흐름, 테넌시
- [docs/design/](docs/design/) — 주요 서브시스템 설계 노트
- [docs/research/](docs/research/) — 조사 및 발견
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 라이선스

리포지토리 설정 참고. 본 프로젝트는 현재 상태 그대로 내부 평가용으로 제공됩니다.
