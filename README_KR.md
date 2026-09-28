# PlayAgent Checker

**게임 / 앱을 위한 AI 기반 자동 QA 플랫폼.** 테스트할 흐름을 일상어로 설명하면 AI 에이전트가 화면을 보고 탭·스와이프를 대신 수행하며 성공/실패를 판정하고, 스크린샷·단계별 트레이스·내비게이션 맵이 포함된 다국어 리포트를 생성합니다.

> 언어: [English](README.md) · [繁體中文](README_ZH.md) · [简体中文](README_CN.md) · [日本語](README_JP.md) · **한국어**

---

## 개요

PlayAgent Checker는 **AWS(리전 `us-east-2`)** 에서 완결되는 서버리스 컨트롤 플레인과 온디맨드 실행 러너로 구성됩니다. 앱을 업로드(또는 웹 URL 지정)하면 에이전트가 자율적으로 탐색하고, 재현 가능하고 검토 가능한 테스트 결과를 얻습니다.

- **실사용 가능한 두 가지 실행 백엔드(모두 엔드투엔드 검증 완료):** **Web**(Playwright 헤드리스 Chromium을 ECS Fargate에서 실행)과 **Device Farm**(AWS Device Farm의 Android/iOS 실기기를 Appium으로 구동).
- **에이전트 루프:** 스크린샷 → VLM 측위 → Agent 결정 → 기기에서 실행 → 다시 스크린샷, 을 목표 달성 또는 중지 조건까지 반복.
- **정확한 GUI 그라운딩(선택):** 좌표 담당 VLM 시트는 SageMaker의 **UI-TARS-1.5-7B**를 사용할 수 있어 그래픽 위주 게임 화면에서 훨씬 정확합니다.
- **지식 베이스, 비용 가드레일, 5개 언어 UI**(zh-Hant, en, zh-Hans, ja, ko).

아키텍처 상세: [docs/architecture.md](docs/architecture.md).

---

# 🚀 깨끗한 AWS 계정에 설치(단계별)

이 절은 **AWS 경험이 전혀 없다**는 전제로 위에서 아래로 진행합니다. 총 소요 시간 약 **45~60분**, 대부분은 AWS 완료 대기입니다.

> 모두 **`us-east-2`(오하이오)** 에 배포합니다. 무엇을 바꾸는지 확실하지 않다면 어디서나 이 리전을 사용하세요.

## 0단계 — 로컬에 도구 설치

로컬에 세 가지가 필요합니다. 아래 확인 명령을 붙여넣어 버전이 출력되면 OK.

| 도구 | 용도 | 설치 |
| --- | --- | --- |
| **Node.js 22+** | 빌드·배포 스크립트 실행 | https://nodejs.org("LTS" 설치 파일) |
| **AWS CLI v2** | AWS 계정과 통신 | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| **Git** | 이 코드 가져오기 | https://git-scm.com/downloads |

```bash
node --version    # v22.x 이상
aws --version     # aws-cli/2.x
git --version
```

Docker는 **필요 없습니다**(대용량 컨테이너 이미지는 클라우드에서 빌드).

## 1단계 — 코드 가져오기

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
```

## 2단계 — AWS CLI를 계정에 연결

계정 소유자에게 **Access Key ID**와 **Secret Access Key**를 요청합니다(AWS Console → IAM → 사용자 → 보안 자격 증명 → 액세스 키 생성).

```bash
aws configure
# AWS Access Key ID     : <붙여넣기>
# AWS Secret Access Key : <붙여넣기>
# Default region name   : us-east-2
# Default output format  : json
```

연결 확인(계정 번호가 출력됩니다):

```bash
aws sts get-caller-identity
```

> 이 자격 증명에는 리소스 생성 권한이 필요합니다(Lambda, S3, Cognito, API Gateway, IAM, ECS, SageMaker, Bedrock, CloudFront). 처음에는 관리자(AWS 관리형 정책 `AdministratorAccess`)가 가장 간단합니다. 나중에 좁힐 수 있습니다.

## 3단계 — AI 모델 켜기(Amazon Bedrock)

새 계정은 AI 모델이 기본적으로 **꺼져** 있습니다. 한 번 켜지 않으면 모든 테스트 실행이 실패합니다.

1. AWS Console → **Bedrock** 검색 → 열기 → 오른쪽 위 리전이 **US East (Ohio) us-east-2** 인지 확인.
2. 왼쪽 메뉴 → **Model access** → **Enable specific models / Manage model access**.
3. 최소한 다음을 활성화하고 **Save**(보통 즉시 승인):
   - **Anthropic – Claude Sonnet 4.5**(테스트 케이스 작성·강력한 폴백 VLM)
   - **Amazon – Titan Text Embeddings V2**(지식 베이스 검색)
   - **Amazon – Nova Micro**(보조 서브태스크)
   - 목록에 있으면 **Qwen – Qwen3-VL** 와 **MiniMax**(기본 비전/결정 모델)
4. 상태가 **Access granted** 가 되면 완료. 나중에 더 켤 수 있으며, 앱은 사용 가능한 모델을 나열합니다.

> 팁: 평가 목적이라면 이 리전에서 "모두 활성화"해도 됩니다.

## 4단계 — CDK 준비(계정당 한 번)

인프라는 **AWS CDK**로 정의됩니다. 리전에서 한 번 "bootstrap"이 필요합니다.

```bash
cd infra
npm install
npx cdk bootstrap aws://계정번호/us-east-2
```

"계정번호"를 2단계의 숫자(`aws sts get-caller-identity`)로 바꿉니다. CDK가 코드를 업로드하는 작은 스테이징 버킷을 생성합니다.

## 5단계 — 백엔드 배포

`infra/` 폴더에서:

```bash
AWS_REGION=us-east-2 npx cdk deploy \
  PlayAgentDev-Foundation \
  PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling \
  PlayAgentDev-Execution \
  --require-approval never
```

약 10~15분. 완료 후 아래를 실행하면 필요한 네 값이 출력됩니다(이름은 자동 처리):

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[?contains(OutputKey,'UserPool')].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

찾는 값은 다음 네 가지입니다:

- **User Pool ID** — 이름에 `UserPoolId` 를 포함하는 출력; 예 `us-east-2_XXXXXXXXX`
- **User Pool Client ID** — 이름에 `UserPoolClientId` 를 포함하는 출력; 긴 영숫자 문자열
- **ApiUrl** — `https://xxxx.execute-api.us-east-2.amazonaws.com`
- **WsUrl** — `wss://xxxx.execute-api.us-east-2.amazonaws.com/prod`

## 6단계 — 그 값으로 웹 콘솔 빌드

웹 앱은 빌드 시 이 네 값을 내장합니다. `web/.env.production` 파일을 생성합니다(리포지토리 루트에서):

```bash
cd ../web
npm install
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-east-2
VITE_COGNITO_USER_POOL_ID=붙여넣기_UserPoolId
VITE_COGNITO_CLIENT_ID=붙여넣기_UserPoolClientId
VITE_API_URL=붙여넣기_ApiUrl
VITE_WS_URL=붙여넣기_WsUrl
EOF
```

각 `붙여넣기_...` 를 5단계의 해당 Output으로 바꾸고 빌드:

```bash
npm run build
```

## 7단계 — 웹 콘솔 배포

```bash
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
```

앱 URL(`https://xxxx.cloudfront.net`)을 출력해 열면 로그인 페이지가 보입니다:

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

## 8단계 — 로그인 만들기(첫 사용자)

셀프 가입은 의도적으로 비활성화되어 있어 첫 사용자는 명령줄로 만듭니다. 이메일과 비밀번호(8자 이상, 대소문자와 숫자 포함)를 정하세요. `tenantId` 는 고객별 데이터를 격리합니다 — 회사명 등 짧은 문자열이면 됩니다.

```bash
POOL_ID=붙여넣기_UserPoolId    # 5단계에서

# 테넌트 id 를 가진 사용자 생성
aws cognito-idp admin-create-user --region us-east-2 \
  --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS

# 영구 비밀번호 설정("비밀번호 변경" 프롬프트 회피)
aws cognito-idp admin-set-user-password --region us-east-2 \
  --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --password 'ChangeMe123!' --permanent
```

## 9단계 — 로그인

7단계의 CloudFront URL을 열고 8단계의 이메일/비밀번호로 로그인합니다. **로그인 후 처음 보이는 페이지가 "가이드"** — 모든 기능을 언어별로 안내하는 내장 워크스루입니다. 거기서:

1. **앱** — 앱 생성. 네이티브는 APK/IPA/ZIP 업로드, Web은 URL만.
2. **테스트 케이스** — 흐름을 일상어로 설명, AI가 실행 가능한 케이스로 변환.
3. **작업** — 앱 + 케이스 + 실행 환경(**Web** 또는 **Device Farm**) 선택 후 제출, 실시간 모니터링 가능.
4. **리포트** — AI 설명, 스크린샷, 단계 트레이스, 비용 확인.

✅ **이제 동작하는 환경이 완성되었습니다.**

---

## 선택: UI-TARS(SageMaker)로 좌표 정확도 향상

범용 비전 모델은 그래픽 위주 게임 화면에서 탭 위치를 수백 픽셀 벗어날 수 있습니다. UI-TARS-1.5-7B(GUI 그라운딩용 파인튜닝)는 훨씬 정확합니다. **선택 사항**이며 추가 비용이 발생합니다(활성화 중 GPU가 계속 실행).

```bash
cd agent/sagemaker && npm install
# 클라우드 빌드(로컬 디스크/대역폭 소비 없음): 모델 + vLLM 이미지 → S3/ECR(CodeBuild 경유)
AWS_REGION=us-east-2 node cloudBuild.mjs
# 엔드포인트 생성(가중치·이미지는 이미 준비됨)
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
# 엔드포인트 이름을 engine에 연결(출력된 ENDPOINT_NAME 사용)
cd ../../infra && AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=<엔드포인트 이름>
```

이후 작업 생성 시 좌표 모델로 **UI-TARS 1.5 7B**를 선택하면 됩니다.

> **💲 비용:** UI-TARS 엔드포인트는 `ml.g6e.xlarge`(약 US$1.86/시간)에서 동작하며 켜져 있는 동안 계속 과금됩니다. **사용하지 않을 때는 삭제하세요:**
> ```bash
> node agent/sagemaker/teardownUitars.mjs <엔드포인트 이름>
> ```
> 가중치와 이미지는 S3/ECR에 남아 재생성이 빠릅니다(다운로드/빌드 생략).

설계는 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md) 참고.

## Device Farm(실제 휴대폰) 참고

Web 백엔드는 추가 설정 없이 동작합니다. 실기기 테스트는 **AWS Device Farm**을 사용하며, 프로젝트는 **us-west-2**에 위치하고 러너가 자동 생성합니다. 배포 자격 증명에 Device Farm 권한이 포함되어 수동 설정이 필요 없습니다 — 작업 제출 시 "Device Farm"을 선택하면 됩니다.

---

## 비용, 정리, 문제 해결

**대략적인 운영 비용(평가):** 서버리스 컨트롤 플레인은 저사용 시 월 몇 달러. 테스트 실행은 토큰당 과금(회당 몇 센트~1~2달러, 리포트에 표시). 유일한 큰 비용은 **선택 사항**인 UI-TARS GPU 엔드포인트(가동 중 약 US$1.86/시간).

**전체 삭제**(스택 삭제. 데이터 버킷과 Cognito 사용자 풀은 데이터 손실 방지를 위해 설계상 보존됩니다 — 완전히 지우려면 Console에서 수동 삭제):

```bash
cd infra
AWS_REGION=us-east-2 npx cdk destroy --all
# UI-TARS를 활성화했다면 먼저 엔드포인트 삭제:
node ../agent/sagemaker/teardownUitars.mjs <엔드포인트 이름>
```

**자주 발생하는 문제**

| 증상 | 해결 |
| --- | --- |
| 배포 실패: *"not bootstrapped"* | 4단계(`cdk bootstrap`)를 `us-east-2`에서 실행. |
| 실행 시 모델 관련 / Bedrock *AccessDenied* 오류 | 모델 액세스 활성화(3단계), **us-east-2**에서. |
| 로그인 페이지는 뜨지만 로그인 실패 | `web/.env.production` 값이 틀렸거나, 수정 후 재빌드+재배포하지 않음(6–7단계). |
| 가입 불가 | 의도된 설계 — 사용자는 CLI로 생성(8단계). |
| 리전 오류 / 리소스가 안 보임 | 모두 **us-east-2**. Console 오른쪽 위 리전 선택기 확인. |

---

## 저장소 구조

```
agent/            실행 러너(Fargate 컨테이너 내부에서 동작)
  explorationRunner.mjs    Device Farm 실기기 러너(Appium 루프)
  webExplorationRunner.mjs Web 러너(Playwright headless Chromium)
  imageTools.mjs           VLM용 smart-resize 및 탭 위치 주석
  uitarsClient.mjs         UI-TARS(SageMaker) 측위 클라이언트
  apkMerge.mjs             Device Farm용 XAPK / split-APK 병합
  sagemaker/               UI-TARS 배포: vLLM BYOC 컨테이너 + CodeBuild 스크립트
infra/            AWS CDK 앱(foundation, control-plane, scheduling, execution, frontend)
web/              React + Vite 웹 콘솔(5개 언어 i18n, 자체 제작 SVG)
docs/             아키텍처, 설계 노트, 리서치
```

## 개발자용

```bash
cd infra && npm test     # CDK·단위 테스트
cd web   && npm run ci    # check:i18n + 타입 체크 + 테스트 + build
```

[CONTRIBUTING.md](CONTRIBUTING.md) 와 [docs/architecture.md](docs/architecture.md) 참고.

## 라이선스

리포지토리 설정 참고. 현재 상태 그대로 내부 평가용으로 제공됩니다.
