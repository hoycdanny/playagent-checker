import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider.tsx';
import { TopBar } from './components/TopBar.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import './App.css';

// 路由級 lazy load:各功能頁各自成獨立 chunk,首包只載當前頁(Req 15.2)。
const AppsPage = lazy(() => import('./pages/AppsPage.tsx'));
const AppWorkspacePage = lazy(() => import('./pages/AppWorkspacePage.tsx'));
const CasesPage = lazy(() => import('./pages/CasesPage.tsx'));
const TasksPage = lazy(() => import('./pages/TasksPage.tsx'));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage.tsx'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.tsx'));
const ReportViewPage = lazy(() => import('./pages/ReportViewPage.tsx'));
const DevicesPage = lazy(() => import('./pages/DevicesPage.tsx'));
const MemoryPage = lazy(() => import('./pages/MemoryPage.tsx'));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage.tsx'));
const CostPage = lazy(() => import('./pages/CostPage.tsx'));
const MembersPage = lazy(() => import('./pages/MembersPage.tsx'));
const GuidePage = lazy(() => import('./pages/GuidePage.tsx'));

/**
 * App —— 路由守衛:未登入顯示登入頁,登入後顯示 shell + 各功能頁路由。
 */
export function App() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <HashRouter>
      <div className="app-shell">
        <TopBar />
        <main className="app-shell__content" role="main">
          <Suspense fallback={<div className="app-shell__loading" aria-hidden="true" />}>
            <Routes>
              <Route path="/guide" element={<GuidePage />} />
              <Route path="/apps" element={<AppsPage />} />
              <Route path="/apps/:appId" element={<AppWorkspacePage />} />
              <Route path="/cases" element={<CasesPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:jobId" element={<TaskDetailPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/:jobId" element={<ReportViewPage />} />
              <Route path="/devices" element={<DevicesPage />} />
              <Route path="/memory" element={<MemoryPage />} />
              <Route path="/knowledge" element={<KnowledgePage />} />
              <Route path="/cost" element={<CostPage />} />
              <Route path="/members" element={<MembersPage />} />
              <Route path="*" element={<Navigate to="/guide" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </HashRouter>
  );
}
