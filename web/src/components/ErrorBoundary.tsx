import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 包裝範圍的簡短名稱,顯示在錯誤訊息裡方便定位(例如 "任務詳情頁")。 */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * 全站目前完全沒有 Error Boundary(main.tsx 的渲染樹沒有任何一層捕捉子樹渲染期例外) ——
 * 任何畫面在渲染期間丟出未捕捉例外(例如把物件當 React child、.map 遇到非預期型別),
 * 整棵 React 樹會 unmount,使用者只會看到一片空白,且沒有任何錯誤提示或重試手段。
 *
 * 這在長任務(數百步、資料量大)的任務詳情/報告頁尤其容易發生:後端欄位型別若因模型輸出
 * 異常、runner 版本差異而偶爾跑掉(例如 thinking 不是字串而是物件),就會觸發此類例外。
 *
 * 用這個邊界包住容易因外部資料形狀不穩定而出錯的頁面(任務詳情、報告檢視),渲染失敗時
 * 顯示錯誤訊息 + 重試按鈕,而不是整頁空白、無從判斷發生什麼事。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
            {this.props.label ? `${this.props.label} 載入時發生錯誤` : '這個畫面載入時發生錯誤'}
          </p>
          <p style={{ color: 'var(--text-muted, #888)', marginBottom: '1rem', fontSize: '0.9em' }}>
            {this.state.error.message}
          </p>
          <button type="button" onClick={this.reset}>
            重試
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
