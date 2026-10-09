import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import type { Session, User } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { getSupabaseClient, isSupabaseConfigured } from '../auth/supabase';
import { forgetBillingUser, identifyBillingUser } from '../billing/purchases';
import { disableApmPushForSignOut } from '../integrations/push';
import { mergeAnonymousIntakeDraft, reviewerSignIn, saveDisplayName, setAccessTokenRefresher } from '../api/apmApi';

type SessionStatus = 'loading' | 'signed_out' | 'signed_in' | 'unconfigured';

/**
 * Accounts without friction (docs/34 §5): the intake starts on a silent anonymous session
 * (when the project allows it); "Save your plan" links Apple (iOS only), Google or a
 * 6-digit email code to the SAME user id, so nothing is copied or lost. Signing in with an
 * identity that already has an account signs in to it and the server merges the anonymous
 * draft by rule (§5 9c). No passwords. User copy never names vendors.
 */
export type AccountProvider = 'apple' | 'google' | 'email';
export interface AccountResult {
  outcome: 'linked' | 'signed_in' | 'merged' | 'cancelled';
  provider: AccountProvider;
  /** "pending_edit" when the existing account already had an OS (answers wait as an edit). */
  mergeOutcome?: string;
  firstName?: string;
}

interface SessionContextValue {
  status: SessionStatus;
  session: Session | null;
  user: User | null;
  accessToken?: string;
  isAnonymous: boolean;
  /** The name from Apple / Google / the code screen (account data, never an intake answer). */
  firstName?: string;
  error?: string;
  /** Silent anonymous session on "Start". False when the project does not allow it: the draft stays on this device. */
  startAnonymous: () => Promise<boolean>;
  sendEmailCode: (email: string) => Promise<void>;
  verifyEmailCode: (email: string, code: string, firstName?: string) => Promise<AccountResult>;
  /** Settings: change the name APM greets you with. Throws when it did not save. */
  updateName: (name: string) => Promise<void>;
  signInWithApple: () => Promise<AccountResult>;
  signInWithGoogle: () => Promise<AccountResult>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Plain errors only: no vendor names, no codes (detail goes to logs). */
export function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/token.*(expired|invalid)|otp|code/i.test(message)) return 'That code didn\'t match. Try again or resend.';
  if (/rate|too many/i.test(message)) return 'Too many tries. Wait a minute and try again.';
  if (/network|fetch/i.test(message)) return 'You seem to be offline. Your answers are saved on this phone.';
  if (/configuration|not configured/i.test(message)) return 'Setup isn\'t finished on this build.';
  return 'That didn\'t work. Try again, or use another way to save.';
}

const alreadyExists = (error: { code?: string; message?: string } | null | undefined) =>
  Boolean(error && (/identity_already_exists|email_exists|user_already_exists/.test(error.code ?? '') || /already (been )?(registered|exists|linked)/i.test(error.message ?? '')));

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string>();
  const [firstName, setFirstName] = useState<string>();
  // The email-code mode chosen when the code was sent.
  const emailMode = useRef<'link' | 'signin' | 'existing' | 'review'>('signin');
  // The anonymous session's token, kept while signing in to an existing account (merge proof).
  const anonymousToken = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setStatus('unconfigured');
      return;
    }
    const supabase = getSupabaseClient();
    let active = true;
    // One refresh-and-retry when the API answers 401 (an expired token after a long background).
    setAccessTokenRefresher(async () => (await supabase.auth.refreshSession()).data.session?.access_token);
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) {
        console.warn('APM session restore failed', sessionError.message);
        setSession(null);
        setStatus('signed_out');
        return;
      }
      setSession(data.session);
      setStatus(data.session ? 'signed_in' : 'signed_out');
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setError(undefined);
      setSession(nextSession);
      setStatus(nextSession ? 'signed_in' : 'signed_out');
    });
    return () => {
      active = false;
      setAccessTokenRefresher(undefined);
      subscription.unsubscribe();
    };
  }, []);

  // RevenueCat app user id = Supabase user id (docs/33); forgotten on sign-out.
  const userId = session?.user?.id;
  useEffect(() => {
    if (userId) void identifyBillingUser(userId).catch(() => undefined);
    else void forgetBillingUser();
  }, [userId]);

  const isAnonymous = Boolean((session?.user as (User & { is_anonymous?: boolean }) | undefined)?.is_anonymous);

  const value = useMemo<SessionContextValue>(() => {
    const supabase = () => getSupabaseClient();
    // The typed name goes to BOTH the auth profile and the identity Today greets with
    // (PUT /v1/profile/name -> user_profiles.display_name), as the account just signed in to.
    // Sign-in never fails over a name; Settings (`strict`) reports a failure.
    const saveName = async (name?: string, strict = false) => {
      const clean = name?.trim().slice(0, 60);
      if (!clean) return;
      setFirstName(clean);
      await supabase().auth.updateUser({ data: { display_name: clean } }).catch(() => undefined);
      try {
        const token = (await supabase().auth.getSession()).data.session?.access_token;
        if (!token) throw new Error('not signed in');
        await saveDisplayName(clean, token);
      } catch (cause) { if (strict) throw cause; }
    };
    /** After signing in to an EXISTING account: the server merges the anonymous draft. */
    const mergeFromAnonymous = async (nextToken?: string): Promise<string | undefined> => {
      const anonToken = anonymousToken.current;
      anonymousToken.current = undefined;
      if (!anonToken || !nextToken) return undefined;
      try { return (await mergeAnonymousIntakeDraft(anonToken, nextToken)).outcome; }
      catch { return undefined; /* the device still holds the draft and re-saves it under the account */ }
    };
    const fail = (cause: unknown): never => {
      console.warn('APM account step failed', cause instanceof Error ? cause.message : cause);
      const message = friendlyAuthError(cause);
      setError(message);
      throw new Error(message);
    };

    return {
      status,
      session,
      user: session?.user ?? null,
      accessToken: session?.access_token,
      isAnonymous,
      firstName: firstName ?? ((session?.user?.user_metadata as { display_name?: string; given_name?: string; full_name?: string } | undefined)?.display_name
        ?? (session?.user?.user_metadata as { given_name?: string } | undefined)?.given_name),
      error,
      startAnonymous: async () => {
        if (!isSupabaseConfigured()) return false;
        if (session) return true;
        const { error: anonError } = await supabase().auth.signInAnonymously();
        if (anonError) { console.warn('APM anonymous session unavailable', anonError.message); return false; }
        return true;
      },
      sendEmailCode: async (email) => {
        setError(undefined);
        const address = email.trim().toLowerCase();
        try {
          // App Review demo account (docs/33 §8): the server says so only for its one address.
          if ((await reviewerSignIn({ email: address }))?.review) { emailMode.current = 'review'; return; }
          if (session && isAnonymous) {
            const { error: linkError } = await supabase().auth.updateUser({ email: address });
            if (!linkError) { emailMode.current = 'link'; return; }
            if (!alreadyExists(linkError)) throw linkError;
            // The address already has an account: sign in to it; the draft merges after.
            anonymousToken.current = session.access_token;
            emailMode.current = 'existing';
            const { error: otpError } = await supabase().auth.signInWithOtp({ email: address, options: { shouldCreateUser: false } });
            if (otpError) throw otpError;
            return;
          }
          emailMode.current = 'signin';
          const { error: otpError } = await supabase().auth.signInWithOtp({ email: address, options: { shouldCreateUser: true } });
          if (otpError) throw otpError;
        } catch (cause) { fail(cause); }
      },
      updateName: (name) => saveName(name, true),
      verifyEmailCode: async (email, code, name) => {
        setError(undefined);
        const address = email.trim().toLowerCase();
        try {
          if (emailMode.current === 'review') {
            const review = await reviewerSignIn({ email: address, code: code.trim() });
            if (!review?.session) throw new Error('code did not match');
            if (session && isAnonymous) anonymousToken.current = session.access_token;
            const { data, error: setError_ } = await supabase().auth.setSession(review.session);
            if (setError_) throw setError_;
            await saveName(name);
            const mergeOutcome = await mergeFromAnonymous(data.session?.access_token);
            return { outcome: mergeOutcome ? 'merged' : 'signed_in', provider: 'email', ...(mergeOutcome ? { mergeOutcome } : {}), ...(name ? { firstName: name } : {}) };
          }
          const type = emailMode.current === 'link' ? 'email_change' : 'email';
          const { data, error: verifyError } = await supabase().auth.verifyOtp({ email: address, token: code.trim(), type });
          if (verifyError) throw verifyError;
          await saveName(name);
          if (emailMode.current === 'existing') {
            const mergeOutcome = await mergeFromAnonymous(data.session?.access_token);
            return { outcome: 'merged', provider: 'email', ...(mergeOutcome ? { mergeOutcome } : {}), ...(name ? { firstName: name } : {}) };
          }
          return { outcome: emailMode.current === 'link' ? 'linked' : 'signed_in', provider: 'email', ...(name ? { firstName: name } : {}) };
        } catch (cause) { return fail(cause); }
      },
      signInWithApple: async () => {
        setError(undefined);
        if (Platform.OS !== 'ios') return fail(new Error('Apple sign-in is iOS only'));
        try {
          // Native module, iOS only: loaded on demand so web and Android never import it.
          const Apple = await import('expo-apple-authentication');
          const rawNonce = Crypto.randomUUID();
          const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
          const credential = await Apple.signInAsync({
            requestedScopes: [Apple.AppleAuthenticationScope.FULL_NAME, Apple.AppleAuthenticationScope.EMAIL],
            nonce: hashed,
          }).catch((cause: { code?: string }) => { if (cause?.code === 'ERR_REQUEST_CANCELED') return null; throw cause; });
          if (!credential) return { outcome: 'cancelled', provider: 'apple' };
          if (!credential.identityToken) throw new Error('Apple returned no identity token');
          // Apple returns the name only on the first authorisation: save it at once.
          const name = credential.fullName?.givenName ?? undefined;
          if (session && isAnonymous) {
            const { error: linkError } = await supabase().auth.linkIdentity({ provider: 'apple', token: credential.identityToken, nonce: rawNonce });
            if (!linkError) { await saveName(name); return { outcome: 'linked', provider: 'apple', ...(name ? { firstName: name } : {}) }; }
            if (!alreadyExists(linkError)) throw linkError;
            anonymousToken.current = session.access_token;
          }
          const { data, error: signInError } = await supabase().auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce: rawNonce });
          if (signInError) throw signInError;
          await saveName(name);
          const mergeOutcome = await mergeFromAnonymous(data.session?.access_token);
          return { outcome: mergeOutcome ? 'merged' : 'signed_in', provider: 'apple', ...(mergeOutcome ? { mergeOutcome } : {}), ...(name ? { firstName: name } : {}) };
        } catch (cause) { return fail(cause); }
      },
      signInWithGoogle: async () => {
        setError(undefined);
        try {
          const redirectTo = Linking.createURL('auth/callback');
          const openFlow = async (url: string | undefined) => {
            if (!url) throw new Error('No sign-in address returned');
            const result = await WebBrowser.openAuthSessionAsync(url, redirectTo);
            if (result.type !== 'success') return null;
            const parsed = new URL(result.url);
            const params = new URLSearchParams(parsed.search || parsed.hash.replace(/^#/, ''));
            const failure = params.get('error_code') ?? params.get('error');
            if (failure) return { failure };
            const code = params.get('code');
            if (!code) throw new Error('No sign-in code returned');
            const { data, error: exchangeError } = await supabase().auth.exchangeCodeForSession(code);
            if (exchangeError) throw exchangeError;
            return { session: data.session };
          };
          if (session && isAnonymous) {
            const { data, error: linkError } = await supabase().auth.linkIdentity({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } });
            if (linkError) throw linkError;
            const linked = await openFlow(data.url);
            if (!linked) return { outcome: 'cancelled', provider: 'google' };
            if (!('failure' in linked)) return { outcome: 'linked', provider: 'google' };
            if (!/identity_already_exists|already/.test(linked.failure ?? '')) throw new Error(linked.failure);
            anonymousToken.current = session.access_token;
          }
          const { data, error: oauthError } = await supabase().auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } });
          if (oauthError) throw oauthError;
          const signedIn = await openFlow(data.url);
          if (!signedIn) return { outcome: 'cancelled', provider: 'google' };
          if ('failure' in signedIn) throw new Error(signedIn.failure);
          const name = (signedIn.session?.user.user_metadata as { given_name?: string; name?: string } | undefined)?.given_name;
          if (name) setFirstName(name);
          const mergeOutcome = await mergeFromAnonymous(signedIn.session?.access_token);
          return { outcome: mergeOutcome ? 'merged' : 'signed_in', provider: 'google', ...(mergeOutcome ? { mergeOutcome } : {}), ...(name ? { firstName: name } : {}) };
        } catch (cause) { return fail(cause); }
      },
      signOut: async () => {
        const supabase = getSupabaseClient();
        if (session?.access_token) await disableApmPushForSignOut(session.access_token);
        const { error: signOutError } = await supabase.auth.signOut();
        // The name typed this session belongs to the account just left, never to the next one.
        if (!signOutError) setFirstName(undefined);
        if (signOutError) {
          setError(friendlyAuthError(signOutError));
          throw signOutError;
        }
      },
    };
  }, [error, firstName, isAnonymous, session, status]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
