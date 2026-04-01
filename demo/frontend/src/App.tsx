import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { AppLayout } from "./components/AppLayout";
import { Dashboard } from "./pages/Dashboard";
import { Models } from "./pages/Models";
import { ApiKeys } from "./pages/ApiKeys";
import { Playground } from "./pages/Playground";
import { Usage } from "./pages/Usage";
import { LoginPage } from "./pages/LoginPage";

function ProtectedRoutes() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return null;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/models" element={<Models />} />
        <Route path="/api-keys" element={<ApiKeys />} />
        <Route path="/playground" element={<Playground />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
