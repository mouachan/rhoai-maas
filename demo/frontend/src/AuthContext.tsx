import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { Session } from "./types";
import { autoLogin, login as apiLogin } from "./api";

interface AuthState {
  session: Session | null;
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
  login: (token: string) => Promise<void>;
  logout: () => void;
  updateSession: (session: Session) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    autoLogin()
      .then((res) => {
        if (res.success && res.session) {
          setSession(res.session);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (token: string) => {
    setError(null);
    setLoading(true);
    try {
      const res = await apiLogin(token);
      if (res.success && res.session) {
        setSession(res.session);
      } else {
        setError(res.error || "Login failed");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    setSession(null);
    setError(null);
  }, []);

  const updateSession = useCallback((s: Session) => {
    setSession(s);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session,
        isAuthenticated: !!session,
        loading,
        error,
        login,
        logout,
        updateSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
