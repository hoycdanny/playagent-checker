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

## 누구를 위한 것인가

- **QA 팀**: 깨지기 쉬운 UI 스크립트를 작성·유지하지 않고 게임/앱을 테스트하고 싶은 팀.
- **다수 타이틀을 출시하는 스튜디오**(슬롯, RPG, MMORPG, 캐주얼…): 빌드마다 재현 가능한 스모크/회귀 테스트가 필요.
- **누구나**: 흐름을 말로 설명할 수 있지만 자동화 프레임워크는 배우고 싶지 않은 사람.

## 동작 원리(엔드투엔드)

```
① 앱 생성      APK/IPA/ZIP 업로드, 또는 웹 URL 지정. 장르 태그.
② 테스트 케이스  흐름을 일상어로 설명 → AI가 실행 가능한 YAML 생성.
③ (선택)지식     장르/시나리오 지식을 연결해 AI가 도메인을 이해하게 함.
④ 작업 제출     실행 환경(Web / Device Farm) + 좌표 모델 선택, 클라우드 큐에 등록.
⑤ AI 실행      스크린샷 → VLM 좌표 측위 → Agent 결정 → 실행 → 반복.
⑥ 리포트 + 기억  다국어 리포트(설명·스크린샷·트레이스·비용) + 실행을 가로질러 쌓이는 내비 맵.
```

AI는 **깨지기 쉬운 요소 선택자에 의존하지 않습니다** —— 사람 테스터처럼 「실제 화면을 봅니다」. 그래서 검사 가능한 UI 트리가 없는 캔버스형 게임(Cocos2d-x, Unity)에서도 동작합니다.

## 기능 개요(각 페이지의 역할)

| 페이지 | 역할 |
| --- | --- |
| **가이드** | 내장 워크스루(로그인 후 첫 페이지), 5개 언어. |
| **앱** | 게임/앱마다 하나의 워크스페이스. 이름 + 플랫폼 + 장르 설정. 네이티브는 아티팩트 업로드, Web은 URL만. 케이스·작업·리포트·기억을 모아둠. |
| **테스트 케이스** | 케이스 = AI가 실행할 하나의 흐름. 일상어로 초안(AI → YAML) 또는 YAML 직접 작성. 시크릿은 `${ENV}` 플레이스홀더, 리터럴 비밀번호는 거부. |
| **작업** | 케이스를 실행. **실행 환경**(Web 브라우저 또는 Device Farm 실기기), **좌표 모델**(기본 UI-TARS), 여러 **지식 베이스**를 선택. 실시간 모니터링·취소 가능. |
| **리포트** | 읽기 전용 결과: AI 설명, 단계 트레이스, 게임 스크린샷, 내비 그래프, 예산 vs 실제 비용·토큰 사용량. |
| **메모리 맵** | 모든 실행을 가로질러 쌓인 앱 전체 그림: 방문한 화면은 노드, 전환은 엣지 —— 이후 테스트가 더 빨리 도달. |
| **지식** | 사용자 간 공유되는 재사용 지식 베이스. 두 종류(장르 / 시나리오), 각각 **Markdown**(전체 주입)과/또는 **PDF 검색**(업로드 문서 벡터 검색). |
| **디바이스** | AWS Device Farm에서 현재 사용 가능한 실기기 모델을 조회. 클라우드 러너는 작업마다 자동 생성·완료 시 회수, 수동 관리 불필요. |

## AI: 세 가지 모델 「시트」

모델은 벤더가 아니라 **역할(시트)**로 구성되며, 작업마다 개별 선택합니다:

- **Agent(결정)** —— 두뇌. 현재 화면과 목표를 보고 다음 동작을 결정.
- **VLM(좌표)** —— 시각. 「누를 대상」을 화면의 실제 픽셀로 변환. **기본값은 SageMaker의 UI-TARS-1.5-7B**(GUI 그라운딩용 파인튜닝. 게임 화면에서 범용 모델보다 훨씬 정확, 번체 중국어로 응답).
- **Subagent(보조)** —— 저렴한 모델로 가벼운 서브태스크를 처리해 비용 절감.

지식 검색은 **Amazon Titan Text Embeddings v2** 와 **Amazon Bedrock Knowledge Bases + S3 Vectors** 를 사용. SDK/엔드포인트는 선택하지 않으며 modelId에서 자동 도출됩니다.

## 비용 가드레일

모든 작업에는 예산이 있습니다. 실행 전 각 시트 모델의 **가격 스냅샷을 고정**(페일-클로즈: 가격 불명이면 실행 거부, 불명 비용으로 시작하지 않음). 누적이 예산에 도달하면 중지하고, 리포트에 실제 비용과 토큰 사용량을 표시합니다.

## 용어

- **Seat(시트)** —— 모델의 역할(Agent / VLM / SubAgent). 벤더가 아님.
- **VLM** —— 비전-언어 모델. 스크린샷을 읽고 좌표를 측위.
- **UI-TARS** —— GUI 그라운딩용으로 파인튜닝된 ByteDance 비전 모델. vLLM으로 SageMaker에 배포. smart-resize된 이미지에서 절대 픽셀을 반환.
- **Agent 루프** —— 스크린샷 → VLM 측위 → Agent 결정 → 실행 → 반복. 엔진은 항상 클라우드(Lambda 오케스트레이션, 러너는 Fargate).
- **지식 베이스** —— Markdown(전체 주입) 또는 PDF 검색(작업 목표로 벡터 검색).
- **Locality** —— 테스트 기기의 위치: `cloud`(클라우드 제공) 또는 `attached`(등록한 로컬 기기, 클라우드 두뇌가 원격 구동).
- **종료 상태** —— 작업의 종료 상태: `pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`.
- **페일-클로즈** —— 가격 불명이면 불명 비용으로 시작하지 않고 실행 거부.

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

> **선택 —— 비용 할당 태그.** 모든 리소스에 `project`, `stage`, `component`가 자동으로 붙습니다. 배포 시 `-c`로 자체 태그(예: 특정 코스트 센터로 청구)를 전달할 수 있습니다. 이 태그는 런타임에 시작되는 EC2/Fargate를 포함한 모든 리소스에 전파되며, 활성화하면 **비용 분석** 페이지에서 사용됩니다(아래 "비용 분석 페이지 활성화" 참조).
>
> ```bash
> AWS_REGION=us-east-2 npx cdk deploy \
>   PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
>   PlayAgentDev-Scheduling PlayAgentDev-Execution \
>   --require-approval never \
>   -c costCenter=QA-1234 -c owner=alice -c team=game-qa
> ```
>
> 사용 가능한 키: `costCenter`, `owner`, `team`, `env`, `costAllocation`. 태그가 일관되도록 각 스택을 배포할 때마다 동일한 `-c` 플래그를 사용하세요.

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

## 6단계 — UI-TARS 좌표 모델 배포(필수)

PlayAgent는 정확한 화면 좌표를 위해 SageMaker의 **UI-TARS-1.5-7B**를 사용합니다. 이는 기본값이자 좋은 결과를 위한 필수 요소입니다(범용 모델은 게임 화면에서 탭 위치를 수백 픽셀 벗어남). 빌드는 전부 클라우드에서 수행되어 로컬 디스크/대역폭을 **소비하지 않습니다**.

```bash
cd ../agent/sagemaker && npm install
# 1) 클라우드 빌드: 모델 다운로드, 서빙 이미지 빌드, 계정으로 push(AWS CodeBuild).
#    약 20~40분. AWS 내에서 실행되며 로컬에는 아무것도 다운로드되지 않음.
AWS_REGION=us-east-2 node cloudBuild.mjs
# 2) 엔드포인트 생성(가중치·이미지는 이미 준비됨). InService 되면 ENDPOINT_NAME 출력.
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
```

마지막에 출력되는 `ENDPOINT_NAME=ui-tars-...` 를 적어 두세요. 그런 다음 engine에 연결하고 execution 스택만 다시 배포합니다:

```bash
cd ../../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=붙여넣기_ENDPOINT_NAME
```

> **💲 중요 비용 안내:** UI-TARS는 GPU 인스턴스(`ml.g6e.xlarge`, 약 US$1.86/시간)에서 동작하며 **켜져 있는 동안 계속 과금**됩니다. 그날 테스트가 끝나면 꺼 주세요:
> ```bash
> node agent/sagemaker/teardownUitars.mjs 붙여넣기_ENDPOINT_NAME
> ```
> 모델과 이미지는 저장되어 재시작은 몇 분이면 됩니다(위 2단계를 skip 플래그로 다시 실행 후 execution 스택 재배포).

## 7단계 — 그 값으로 웹 콘솔 빌드

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

## 8단계 — 웹 콘솔 배포

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

## 9단계 — 첫 번째(관리자) 로그인 만들기

셀프 가입은 의도적으로 비활성화되어 있어 사용자는 직접 만듭니다. 이메일과 비밀번호(8자 이상, 대소문자와 숫자 포함)를 정하세요. `tenantId` 는 고객별 데이터를 격리합니다 — 회사명 등 짧은 문자열이면 됩니다. 첫 사용자를 **관리자**로 만들면 이후에는 앱 내 「멤버 관리」 페이지에서 다른 사용자를 관리할 수 있습니다.

하나를 선택하세요:

**옵션 A — 원커맨드 스크립트(권장).** 사용자 생성, 영구 비밀번호 설정을 하고 `--admin` 이면 `admins` 그룹에도 추가합니다. User Pool 은 자동 해석됩니다.

```bash
cd agent/sagemaker && npm install
AWS_REGION=us-east-2 node createUser.mjs \
  --email you@example.com --tenant acme --password 'ChangeMe123!' --admin
```

**옵션 B — 배포 시 관리자 생성.** Foundation 스택(또는 임의의 배포)에 `-c` 로 전달하면 CDK 가 생성하고 `admins` 그룹에 추가합니다:

```bash
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Foundation --require-approval never \
  -c adminEmail=you@example.com -c adminPassword='ChangeMe123!' -c adminTenant=acme
```

관리자가 한 명 있으면 나머지는 앱의 「멤버 관리」 페이지에서 만들 수 있습니다(10단계 참조) — 명령줄이 필요 없습니다. 관리자가 아닌 사용자에게는 해당 페이지가 보이지 않습니다.

<details>
<summary>옵션 C — 순수 AWS CLI(스크립트 미사용)</summary>

```bash
POOL_ID=붙여넣기_UserPoolId    # 5단계에서
aws cognito-idp admin-create-user --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --password 'ChangeMe123!' --permanent
# 관리자로 지정(「멤버 관리」 페이지 사용을 위해)
aws cognito-idp admin-add-user-to-group --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --group-name admins
```
</details>

## 10단계 — 로그인

8단계의 CloudFront URL을 열고 9단계의 이메일/비밀번호로 로그인합니다. **로그인 후 처음 보이는 페이지가 "가이드"** — 모든 기능을 언어별로 안내하는 내장 워크스루입니다. 거기서:

1. **앱** — 앱 생성. 네이티브는 APK/IPA/ZIP 업로드, Web은 URL만.
2. **테스트 케이스** — 흐름을 일상어로 설명, AI가 실행 가능한 케이스로 변환.
3. **작업** — 앱 + 케이스 + 실행 환경(**Web** 또는 **Device Farm**) 선택 후 제출. 좌표 모델은 **6단계**에서 설치한 **UI-TARS 1.5 7B**가 기본값입니다. 실시간 모니터링 가능.
4. **리포트** — AI 설명, 스크린샷, 단계 트레이스, 비용 확인.
5. **멤버 관리**(관리자 전용) — 내비게이션 마지막 항목. 사용자 추가(이메일 + 테넌트 + 초기 비밀번호), 계정 비활성화/활성화, 선택적으로 관리자 권한 부여. 첫 관리자 이후에는 명령줄이 필요 없습니다.

> **「멤버 관리」가 보이지 않으면:** 내비게이션은 관리자에게만 표시되며, 로그인 token의 그룹 정보는 「로그인한 시점」 상태만 반영합니다. 계정을 관리자로 만든(9단계) 후에는 **로그아웃 후 다시 로그인**해야 새 token에 `admins` 그룹이 포함됩니다.

✅ **이제 동작하는 환경이 완성되었습니다.**

UI-TARS 그라운딩 원리는 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md) 참고.

## 비용 분석 페이지 활성화

**비용 분석** 페이지("지식 관리" 옆)는 두 가지 수치를 나란히 보여줍니다:

- **AWS 실제 비용** —— **AWS Cost Explorer**에서 실시간으로 가져옵니다: 실제 청구서를 서비스별, `component` 태그별, 월별로 분해합니다. 모든 것(SageMaker GPU, Fargate, EC2, CloudFront 등)을 포함합니다.
- **작업 추정 비용** —— 작업의 token × 단가 추정을 합산하여 앱별, 모델별로 집계합니다. 인프라를 포함하지 않아 실제 청구서보다 낮으며, 기준이 다르므로 서로 빼면 안 됩니다.

추정 쪽은 즉시 사용할 수 있습니다. 실제 쪽은 **일회성 계정 설정**이 필요합니다(Cost Explorer는 계정 수준이라 CDK로 활성화할 수 없습니다):

1. **Cost Explorer 활성화.** AWS 콘솔에서 **Billing and Cost Management → Cost Explorer**로 이동하여 활성화합니다. 최초 활성화 후 약 **24시간** 뒤 데이터가 나타나기 시작합니다.
2. **비용 할당 태그 활성화.** **Billing and Cost Management → Cost allocation tags → User-defined cost allocation tags**에서 `project`, `stage`, `component`(및 배포 시 전달한 `costCenter` / `owner` / `team` 등)를 선택하고 **Activate**를 클릭합니다.
3. **다음 날 확인.** 태그는 활성화 **이후** 발생한 비용에만 적용됩니다 —— 과거 비용은 소급되지 않으며, 그전까지 `component`별 집계는 모두 "태그 없음"으로 표시됩니다. 다음 날 다시 확인하세요.

참고:

- Cost Explorer API는 `us-east-1`에만 있습니다. 배포 리전과 관계없이 앱이 해당 리전으로 조회합니다.
- 쿼리마다 AWS가 약 **US$0.01**을 청구하며, 데이터는 보통 약 24시간 지연됩니다(실시간 아님).
- 계정 소유자 / 청구 권한이 있는 IAM 사용자만 비용 할당 태그를 활성화할 수 있습니다.

## Device Farm(실제 휴대폰) 참고

Web 백엔드는 추가 설정 없이 동작합니다. 실기기 테스트는 **AWS Device Farm**을 사용하며, 프로젝트는 **us-west-2**에 위치하고 러너가 자동 생성합니다. 배포 자격 증명에 Device Farm 권한이 포함되어 수동 설정이 필요 없습니다 — 작업 제출 시 "Device Farm"을 선택하면 됩니다.

---

## 비용, 정리, 문제 해결

**대략적인 운영 비용(평가):** 서버리스 컨트롤 플레인은 저사용 시 월 몇 달러. 테스트 실행은 토큰당 과금(회당 몇 센트~1~2달러, 리포트에 표시). 가장 큰 비용은 **UI-TARS GPU 엔드포인트**(`ml.g6e.xlarge`, 약 US$1.86/시간) — 켜져 있는 동안 계속 과금되므로 **테스트하지 않을 때는 끄세요**(`node agent/sagemaker/teardownUitars.mjs <엔드포인트 이름>`). 재생성은 몇 분이면 됩니다.

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
