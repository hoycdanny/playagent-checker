import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // CDK stack synth(含 Lambda bundling)在多檔並行時單檔可能超過預設 5s;
    // 純單元測試仍快。放寬至 30s 以吸收並行合成負載。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
