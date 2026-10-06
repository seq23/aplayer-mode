import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClient, isSupabaseConfigured } from '../auth/supabase';

type SessionStatus = 'loading' | 'signed_out' | 'signed_in' | 'unconfigured';

interface SessionContextValue {
  status: SessionStatus;
  session: Session | null;
  user: User | null;
  accessToken?: string;
  error?: string;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setStatus('unconfigured');
      return;
    }

    const supabase = getSupabaseClient();
    let active = true;

    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) {
        setError(sessionError.message);
        setSession(null);
        setStatus('signed_out');
        return;
      }
      setSession(data.session);
      setStatus(data.session ? 'signed_in' : 'signed_out');
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setError(undefined);
      setSession(nextSession);
      setStatus(nextSession ? 'signed_in' : 'signed_out');
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      session,
      user: session?.user ?? null,
      accessToken: session?.access_token,
      error,
      signIn: async (email, password) => {
        const supabase = getSupabaseClient();
        setError(undefined);
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) {
          setError(signInError.message);
          throw signInError;
        }
      },
      signUp: async (email, password) => {
        const supabase = getSupabaseClient();
        setError(undefined);
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (signUpError) {
          setError(signUpError.message);
          throw signUpError;
        }
        return { needsEmailConfirmation: !data.session };
      },
      signOut: async () => {
        const supabase = getSupabaseClient();
        const { error: signOutError } = await supabase.auth.signOut();
        if (signOutError) {
          setError(signOutError.message);
          throw signOutError;
        }
      },
    }),
    [error, session, status],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
