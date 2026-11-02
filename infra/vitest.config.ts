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
  },
});
