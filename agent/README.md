# PlayAgent 本地代理(Local Agent)

把你的**筆電桌面 / 本地模擬器 / 本地瀏覽器**註冊為一台受測裝置(`attached`),
讓雲端的 AI 逐步分析你這台裝置上的操作(Req 13)。

## 運作方式(裝置在本地、大腦在雲端)

```
本地裝置 ──擷取畫面──▶ 本地代理 ──(主動撥出 WSS)──▶ 雲端
                                                    │
雲端 VLM 依「上一動之後的影像」判斷下一步座標 ◀──────┘
    │
    └──指令──▶ 本地代理 ──在本地裝置執行──▶ 擷取新畫面 ──▶ …循環
```

- **連線由本地代理主動向雲端撥出**(outbound WSS),不需要你在本地開對外入站埠,
  相容 NAT / 防火牆後的一般筆電(Req 13.2)。
- **決策(Agent/VLM)恆在雲端**;本地代理只負責畫面擷取、動作執行、轉發,
  不含任何測試決策邏輯(Req 13.4)。
- 每步往返延遲(數百毫秒至數秒)為正常,定位於慢節奏 / 逐步行為分析,
  不追求即時動作類遊戲的逐幀時效(Req 13.5)。

## 使用

```bash
# 1. 取得裝置註冊 token(於 Web 介面「裝置」頁註冊本地裝置後取得,或用 CLI 登入)
export PLAYAGENT_TOKEN=<你的 idToken 或裝置註冊 token>
export PLAYAGENT_WS=wss://<ws-id>.execute-api.<region>.amazonaws.com/prod

# 2. 啟動代理(擷取來源:desktop | browser | emulator)
node agent/index.mjs --source desktop
```

> 註:本代理為階段 8 的**程式骨架**。畫面擷取與動作執行的實作(桌面用作業系統 API、
> 瀏覽器用 CDP、模擬器用 adb)依平台而異,已定義好清楚的插槽介面 `Capturer` / `Actuator`,
> 但實際的原生擷取/注入需在有對應裝置的環境測試,不在目前無頭建置環境的驗證範圍內。
