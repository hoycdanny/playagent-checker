import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // 正式建置關閉 sourcemap:先前產生 ~2.4MB map,徒增部署體積且對使用者無益。
    // 需線上除錯時改為 'hidden'(產出 map 但不在 bundle 內引用)。
    sourcemap: false,
    // 資產以內容雜湊命名 → CDN 長快取命中,僅變更檔失效(Req 15.3)。
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // 手動切塊:把體積大且穩定的第三方庫拆成獨立長快取 chunk,
        // 從 556KB 主包分離 → 首次繪製只等較小的主包;函式庫在版本更新前永久命中快取。
        manualChunks: {
          // React 執行期(react + react-dom + scheduler):最穩定、最該長快取。
          'vendor-react': ['react', 'react-dom', 'react-dom/client'],
          // 路由。
          'vendor-router': ['react-router-dom'],
          // 圖形庫(僅 ScreenGraph / ArchitectureGraph 用):最重,拆出後只有進到那些頁才載。
          'vendor-flow': ['@xyflow/react', '@dagrejs/dagre'],
          // AWS Cognito SDK(僅登入用)。
          'vendor-cognito': ['@aws-sdk/client-cognito-identity-provider'],
        },
      },
    },
    // 主包已顯著縮小;把警告門檻調回合理值以便未來回歸時再次示警。
    chunkSizeWarningLimit: 600,
  },
});
