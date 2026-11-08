import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // CDK stack synth(含 Lambda esbuild bundling)很慢:81 個測試檔並行時,實測
    // ws-api 與 control-plane-stack 各要 31.8s / 31.6s —— 剛好卡在原本的 30s 上限,
    // 於是這兩個檔案「偶爾」失敗,而失敗訊息只說 timeout,看不出是負載造成的。
    //
    // 逾時的用途是抓「卡住不動」,不是當效能預算。這組測試現在是部署閘門
    // (buildspec 的 test:infra),閘門會隨機擋下部署比跑久一點糟得多,所以給足餘裕。
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 預設 reporter 會在跑的過程中持續重繪底部摘要,每次重繪都是一次 worker → 主執行緒的
    // `onTaskUpdate` RPC。CDK synth 測試(esbuild bundling)把 CPU 吃滿時,主執行緒來不及
    // 回應,RPC 逾時會被算成一個 unhandled error,於是「全部測試通過但 exit 1」——
    // 閘門被自己的進度條擋下來。
    //
    // 2026-11(測試檔達 89 個、1,081 個測試)起這個現象從偶發變成每次都中。關掉即時摘要
    // 把 RPC 流量降到每個檔案一次;結果摘要照樣會在跑完後印出來,看得到的資訊不變。
    reporters: [['default', { summary: false }]],
    // 但光降流量不夠:CDK synth 測試會把每個核心都吃滿,主執行緒根本排不到 CPU 去回應。
    // 留一半核心給主執行緒與 esbuild 的子程序,RPC 才有機會在逾時前被回答。
    // 這是刻意用「跑久一點」換「不會隨機擋下部署」—— 與上面同一個取捨。
    maxWorkers: '50%',
  },
});
