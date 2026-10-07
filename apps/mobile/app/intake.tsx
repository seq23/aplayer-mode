import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import {
  SCREEN_PLATES,
  answered,
  deferredQuestionIds,
  highPressureSuggested,
  holdingCount,
  path,
  prefillFor,
  progress,
  quickStartCounts,
  quickStartRecommended,
  registry,
  requiredReason,
  resolveDeepLink,
  resumeCursor,
  stepScreen,
  synthesizeProfile,
  type AnswerValue,
  type IntakeMode,
  type Screen as IntakeScreen,
} from '@apm/planning';
import { useIntake } from '../src/intake/store';
import { useSession } from '../src/state/session';
import { synthesizeIntake } from '../src/api/apmApi';
import { plainError } from '../src/api/errors';
import { enableApmPush } from '../src/integrations/push';
import { QuestionView } from '../src/components/intake/QuestionView';
import { Interstitial } from '../src/components/intake/Interstitials';
import { AccountPanel } from '../src/components/intake/AccountPanel';
import { BuildingScreen, DetailScreen, SummaryScreen } from '../src/components/intake/Reveal';
import { Muted, OptionButton, PlateLine, ProgressBar, intakeStyles } from '../src/components/intake/primitives';
import { PlanChoice } from '../src/billing/PlanChoice';
import { Body, Card, CardTitle } from '../src/components/ui';
import { colors, radius, spacing } from '../src/theme';

const DETAIL = new Set(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);

/**
 * The ONE setup route (docs/34 §6 rule 5): the screen comes from the draft's cursor, so the
 * stack never grows. The native header is hidden, iOS swipe-back is off (app/_layout.tsx),
 * Android hardware back is the in-screen Back, and on the first question it asks "Leave
 * setup? Your answers are saved." Every answer goes straight to the draft store.
 */
export default function IntakeScreenRoute() {
  const { draft, answer, patch, setCursor, install, installing, pendingInstall, track, sync } = useIntake();
  const { status, isAnonymous, accessToken, firstName } = useSession();
  const params = useLocalSearchParams<{ q?: string }>();
  const answers = draft.answers;
  const mode = (answers.mode === 'quick' ? 'quick' : answers.mode === 'full' ? 'full' : undefined) as IntakeMode | undefined;
  const all = useMemo(() => registry(answers, mode), [answers, mode]);
  const onPath = useMemo(() => path(answers, mode), [answers, mode]);
  const [screenReader, setScreenReader] = useState(false);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState<string>();
  const viewedAt = useRef(Date.now());
  // Auto-advance fires 250 ms after a tap: it must read the answers AFTER that tap.
  const latest = useRef(answers);
  latest.current = answers;
  const advanceFrom = (id: string, nextMode: IntakeMode | undefined = mode) => go(stepScreen(latest.current, id, 1, nextMode));

  // Resume: a deep link to a hidden question goes to the cursor; a cursor that no longer exists goes to the first open question.
  const cursor = useMemo(() => {
    const stored = draft.cursor;
    const known = all.some((s) => s.id === stored) ? stored : resumeCursor(answers, mode);
    return resolveDeepLink(answers, params.q, known, mode);
  }, [all, answers, draft.cursor, mode, params.q]);
  const screen: IntakeScreen = all.find((s) => s.id === cursor) ?? onPath[0]!;

  useEffect(() => {
    // react-native-web always answers "true" here; the web build keeps auto-advance.
    if (Platform.OS === 'web') return undefined;
    void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => sub.remove();
  }, []);

  // Pre-fill from earlier answers, never asked twice.
  useEffect(() => {
    if (screen.kind !== 'question' || !screen.question) return;
    const filled = prefillFor(screen.question, answers, highPressureSuggested(answers));
    if (filled) patch(filled);
    viewedAt.current = Date.now();
    const p = progress(answers, screen.id, mode);
    track('intake_question_viewed', { qid: screen.id, index: p.index + 1, pathLength: p.total });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen.id]);

  // A signed-in, non-anonymous person never sees "Save your plan" again.
  useEffect(() => {
    if (screen.kind === 'account' && status === 'signed_in' && !isAnonymous && !answers._acct) answer('_acct', 'account');
    if (screen.kind === 'account') track('account_prompt_shown', {});
    if (screen.kind === 'express') track('intake_quick_start_shown', { pathLength: quickStartCounts(answers).fullLeft });
    if (screen.kind === 'plan') track('paywall_viewed', {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen.id]);

  const go = useCallback((id: string) => { setNotice(undefined); setCursor(id); }, [setCursor]);
  const next = useCallback(() => go(stepScreen(answers, cursor, 1, mode)), [answers, cursor, go, mode]);
  const back = useCallback(() => {
    track('intake_back', { qid: cursor });
    if (DETAIL.has(cursor)) return go('summary');
    const target = stepScreen(answers, cursor, -1, mode);
    if (target === cursor) { router.replace('/welcome'); return; }
    go(target);
  }, [answers, cursor, go, mode, track]);

  // Android hardware back = the in-screen Back; on the first question: "Leave setup?"
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (onPath[0]?.id === cursor) {
        Alert.alert('Leave setup?', 'Your answers are saved.', [
          { text: 'Stay', style: 'cancel' },
          { text: 'Leave', onPress: () => router.replace('/welcome') },
        ]);
        return true;
      }
      back();
      return true;
    });
    return () => sub.remove();
  }, [back, cursor, onPath]);

  const onSet = (id: string, value: AnswerValue | undefined) => {
    const had = answers[id] !== undefined;
    answer(id, value);
    if (screen.kind === 'question' && id === screen.id) track('intake_question_answered', { qid: id, ms: Date.now() - viewedAt.current, changed: had });
  };

  const p = progress(answers, cursor, mode);
  const plate = screen.kind === 'question' ? screen.question!.plate : screen.kind === 'interstitial' ? screen.interstitial!.plate : SCREEN_PLATES[screen.id] ?? '';
  const games = Array.isArray(answers.games) ? (answers.games as string[]) : [];

  // ---------------------------------------------------------------- footer state
  let canNext = true;
  let nextLabel = 'Continue';
  let reason: string | undefined;
  let onNext = next;
  if (screen.kind === 'question') {
    reason = requiredReason(screen.question!, answers);
    canNext = !reason;
    if (screen.question!.optional && !answered(screen.question!, answers)) nextLabel = 'Skip';
    if (nextLabel === 'Skip') onNext = () => { track('intake_question_skipped', { qid: screen.id }); next(); };
  }
  if (screen.kind === 'account') { canNext = Boolean(answers._acct); if (!canNext) reason = 'Pick a way to save, or "Not now".'; }
  if (screen.kind === 'express') { canNext = Boolean(answers.mode); }
  if (DETAIL.has(screen.id)) { nextLabel = 'Done'; onNext = () => go('summary'); }
  if (screen.kind === 'summary') {
    const noSession = status !== 'signed_in';
    nextLabel = installing ? 'Installing…' : 'Install my OS';
    canNext = !installing && !noSession;
    if (noSession) reason = 'Save your plan to an account to install it.';
    onNext = () => {
      void (async () => {
        try {
          const result = await install(firstName);
          if (result === 'queued') setNotice('We\'ll finish installing as soon as you\'re online. Your answers are safe.');
          track('onboarding_completed', { mode: mode ?? 'full', games: games.join('.') });
          go('plan');
        } catch (error) {
          setNotice(plainError(error, 'Install did not finish. Try again.'));
        }
      })();
    };
  }
  if (screen.kind === 'building' || screen.kind === 'plan') canNext = false;

  const finishLater = () => { track('intake_finish_later', { qid: cursor }); setPaused(true); };

  if (paused) {
    return (
      <Shell>
        <Text accessibilityRole="header" style={intakeStyles.heading}>Saved. Go do your thing.</Text>
        <Body muted>{`All ${p.answered} answers are safe ${sync === 'saved' ? 'on this phone and in your account' : 'on this phone'}. Open APM any time and you'll be right back on this question.`}</Body>
        <OptionButton role="button" label="Back to my setup" selected={false} onPress={() => { track('intake_resumed', { qid: cursor, gap: 0 }); setPaused(false); }} />
      </Shell>
    );
  }

  const top = screen.kind === 'question' || screen.kind === 'interstitial' ? (
    <View style={styles.top}>
      <View style={styles.topRow}>
        <Text style={styles.eyebrow} numberOfLines={1}>{screen.kind === 'question' ? `${screen.group} · ${p.index + 1} of ${p.total}` : screen.group}</Text>
        <Text style={styles.eyebrow}>{`${p.answered}/${p.total}`}</Text>
      </View>
      <ProgressBar done={p.answered} total={p.total} />
      <View style={styles.topRow}>
        <Muted>{`${holdingCount(answers)} things APM is now holding for you · ${sync === 'saved' ? 'Saved' : 'Saved on this phone'}`}</Muted>
        {screen.kind === 'question' ? <Pressable accessibilityRole="button" onPress={finishLater} style={styles.later}><Text style={styles.laterText}>Finish later</Text></Pressable> : null}
      </View>
    </View>
  ) : null;

  let body: React.ReactNode = null;
  if (screen.kind === 'question') {
    const q = screen.question!;
    const firstInSection = screen.section?.questions.find((z) => onPath.some((s) => s.id === z.id))?.id === q.id;
    body = (
      <QuestionView
        key={q.id}
        question={q}
        answers={answers}
        onSet={onSet}
        onAutoAdvance={() => advanceFrom(q.id)}
        screenReader={screenReader}
        intro={firstInSection ? screen.section?.intro : undefined}
        preselectNote={q.id === 'tone' && answers._pf_tone === true ? 'Pre-selected for your game: the Billionaire High Performance Coach Track runs on High-Pressure Coaching. Tap Continue to confirm, or pick another. You can change it any time.' : undefined}
      />
    );
  } else if (screen.kind === 'interstitial') {
    body = <Interstitial it={screen.interstitial!} answers={answers} />;
  } else if (screen.kind === 'account') {
    body = answers._acct && answers._acct !== 'later'
      ? <Card tone="accent"><CardTitle>Saved.</CardTitle><Body>{`${p.answered} answers are safe. Same account on every device.`}</Body><Muted>Next: your time, your patterns, your week.</Muted></Card>
      : (
        <AccountPanel
          title="Save your plan"
          sub="So nothing you've told APM is lost."
          answeredCount={p.answered}
          onDone={(result) => { answer('_acct', result.provider); track('account_prompt_result', { provider: result.provider, result: result.outcome }); }}
          onLater={() => { answer('_acct', 'later'); track('account_prompt_result', { provider: 'later', result: 'later' }); next(); }}
        />
      );
  } else if (screen.kind === 'express') {
    const counts = quickStartCounts(answers);
    const rec = quickStartRecommended(answers);
    body = (
      <View style={intakeStyles.stack}>
        <Text accessibilityRole="header" style={intakeStyles.heading}>That's enough for a working plan.</Text>
        <Body muted>{`You've answered ${p.answered}. Pick how much more to do today. You can switch later.`}</Body>
        <OptionButton label="Build my plan now" recommended={rec} selected={answers.mode === 'quick'} detail={`${counts.quickLeft} more tap${counts.quickLeft === 1 ? '' : 's'}, under a minute. The other ${Math.max(0, counts.fullLeft - counts.quickLeft)} wait on Today, 2 a day from Day 2.`} onPress={() => { answer('mode', 'quick'); track('intake_quick_start_chosen', { mode: 'quick' }); if (!screenReader) setTimeout(() => advanceFrom('express', 'quick'), 250); }} />
        <OptionButton label="Keep going" selected={answers.mode === 'full'} detail={`About ${counts.fullLeft} more, roughly ${Math.max(1, Math.round((counts.fullLeft * 7) / 60))} minutes. A sharper plan on Day 1.`} onPress={() => { answer('mode', 'full'); track('intake_quick_start_chosen', { mode: 'full' }); if (!screenReader) setTimeout(() => advanceFrom('express', 'full'), 250); }} />
        <Muted>Either way your answers are saved, and the plan only gets better as you add more.</Muted>
      </View>
    );
  } else if (screen.kind === 'building') {
    body = (
      <BuildingScreen
        work={async () => {
          const started = Date.now();
          const catchAll = typeof answers.catchall === 'string' ? answers.catchall : undefined;
          const suggestions = (Array.isArray(answers._suggested_areas) ? (answers._suggested_areas as string[]) : []).map((e) => e.split('|')[0] ?? '');
          if (!accessToken || (!catchAll?.trim() && !suggestions.length)) { track('os_build_ms', { ms: Date.now() - started, reason: 'deterministic' }); return; }
          const today = new Date().toISOString().slice(0, 10);
          const s = synthesizeProfile(answers, { startDate: today });
          const result = await synthesizeIntake({ catchAll, games, ownership: answers.equity === true, trackKeys: s.tracks.filter((t) => t.on).map((t) => t.key), floors: s.pillars.minimumFloors as Record<string, string>, suggestedAreas: suggestions }, accessToken);
          // A model proposal (only from a promoted route) can only ADD Tracks or classify a suggestion.
          if (result.source === 'model') {
            const extra: Record<string, AnswerValue> = {};
            for (const key of result.proposal.trackKeys) if (!s.tracks.some((t) => t.key === key)) extra[`trk_${key}`] = true;
            if (result.proposal.suggestedAreas.length) extra._suggested_areas = result.proposal.suggestedAreas.map((x) => `${x.label}|${x.area}`);
            if (Object.keys(extra).length) patch(extra);
          }
        }}
        onDone={() => go('summary')}
      />
    );
  } else if (screen.kind === 'summary') {
    const saveCard = status !== 'signed_in' || isAnonymous ? (
      <Card tone="warning">
        <AccountPanel
          title={status === 'signed_in' ? 'Save your OS to an account?' : 'Save your plan to install it'}
          sub={status === 'signed_in' ? 'Right now it lives only on this phone.' : 'This build keeps your OS in an account, so a lost phone never loses it.'}
          onDone={(result) => { answer('_acct', result.provider); track('account_prompt_result', { provider: result.provider, result: result.outcome }); }}
        />
      </Card>
    ) : undefined;
    body = (
      <SummaryScreen
        answers={answers}
        onSet={(id, value) => answer(id, value)}
        onOpen={(detail) => go(detail)}
        saveCard={saveCard}
        onPush={(allow) => {
          answer('push', allow);
          track('push_prompt_result', { result: allow ? 'allow' : 'later' });
          if (allow && accessToken) void enableApmPush(accessToken).catch(() => answer('push', false));
        }}
      />
    );
  } else if (screen.kind === 'detail') {
    body = <DetailScreen id={screen.id as 'r1'} answers={answers} onSet={(id, value) => answer(id, value)} />;
  } else if (screen.kind === 'plan') {
    body = (
      <View style={intakeStyles.stack}>
        <Text accessibilityRole="header" style={intakeStyles.heading}>How much should APM carry?</Text>
        {pendingInstall ? <Card tone="warning"><Body>We'll finish installing as soon as you're online. Your answers are safe.</Body></Card> : null}
        <PlanChoice games={games} onboarding onFinished={(result) => { track('paywall_result', { result }); router.replace('/(tabs)/today'); }} />
      </View>
    );
  }

  return (
    <Shell top={top}>
      {body}
      {notice ? <Card tone="warning"><Body>{notice}</Body></Card> : null}
      {screen.kind === 'summary' && deferredQuestionIds(answers).length && mode === 'quick' ? <Muted>{`${deferredQuestionIds(answers).length} questions wait on Today: 2 quick taps a day from Day 2, never on a light day.`}</Muted> : null}
      <PlateLine text={plate} />
      {reason ? <Text style={intakeStyles.why} accessibilityLiveRegion="polite">{reason}</Text> : null}
      <View style={styles.footer}>
        {screen.kind !== 'plan' && screen.kind !== 'building' ? (
          <Pressable accessibilityRole="button" onPress={back} style={({ pressed }) => [styles.btn, styles.btnSecondary, pressed && styles.pressed]}>
            <Text style={styles.btnSecondaryText}>Back</Text>
          </Pressable>
        ) : null}
        {screen.kind !== 'plan' && screen.kind !== 'building' ? (
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canNext }} disabled={!canNext} onPress={onNext} style={({ pressed }) => [styles.btn, !canNext && styles.disabled, pressed && styles.pressed]}>
            <Text style={styles.btnText}>{nextLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </Shell>
  );
}

function Shell({ children, top }: { children: React.ReactNode; top?: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        {top}
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  top: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: 6 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  eyebrow: { color: colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', flexShrink: 1 },
  later: { minHeight: 44, justifyContent: 'center' },
  laterText: { color: colors.accent, fontWeight: '800' },
  body: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md },
  footer: { flexDirection: 'row', gap: spacing.sm },
  btn: { flex: 2, minHeight: 52, borderRadius: radius.md, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  btnSecondary: { flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  btnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
  btnSecondaryText: { color: colors.ink, fontWeight: '800', fontSize: 16 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
});
