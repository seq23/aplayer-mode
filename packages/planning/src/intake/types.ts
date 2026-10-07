import type { AreaKey, PillarName } from '@apm/domain';

/** Intake answer values: ids, numbers, yes/no, id lists, and the one optional text box. */
export type AnswerValue = string | number | boolean | string[];
export type IntakeAnswers = Readonly<Record<string, AnswerValue | undefined>>;

export type GameKey = 'wealth' | 'weight' | 'founder' | 'operator' | 'parent' | 'athlete' | 'student' | 'creator' | 'transition';

export type QuestionType = 'single' | 'multi' | 'slider' | 'time' | 'yesno' | 'weekdays' | 'rank' | 'text';

export type OptionSource = 'fromGames' | 'fromIncome' | 'goalTemplates' | 'goalSteps' | 'floorOptions';

export interface GateHelpers {
  any(a: IntakeAnswers, ...games: GameKey[]): boolean;
  goalHasSize(a: IntakeAnswers): boolean;
  bodyOn(a: IntakeAnswers): boolean;
  pillarOn(a: IntakeAnswers, pillar: PillarName): boolean;
  /** Load 8+ or a recovering / rebuilding season. */
  tough(a: IntakeAnswers): boolean;
}

export type Gate = (a: IntakeAnswers, h: GateHelpers) => boolean;

export interface QuestionDef {
  id: string;
  type: QuestionType;
  /** `goalSize` = the title comes from the chosen goal template. */
  title: string;
  note?: string;
  options?: ReadonlyArray<readonly [string, string]> | OptionSource;
  min?: number;
  max?: number;
  step?: number;
  def?: number;
  unit?: string;
  lo?: string;
  hi?: string;
  minPick?: number;
  maxPick?: number;
  exclusive?: string;
  optional?: boolean;
  /** Asked on the quick start too. */
  essential?: boolean;
  prefill?: 'lines' | 'tone' | 'core' | 'floors' | 'spirit';
  gate?: Gate;
  recommended?: (a: IntakeAnswers, h: GateHelpers) => string | undefined;
  why: string;
  bhpc: string;
  field: string;
  engine: string;
  /** The "taken off your plate" line. */
  plate: string;
}

export interface InterstitialDef {
  id: string;
  kind: 'heard' | 'plan' | 'laws' | 'week' | 'morning';
  title: string;
  plate: string;
}

export interface SectionDef {
  id: string;
  kind: 'questions' | 'account' | 'express';
  name: string;
  intro?: string;
  gate?: Gate;
  after?: InterstitialDef;
  questions: readonly QuestionDef[];
}

export interface GoalTemplate {
  id: string;
  label: string;
  size?: { min: number; max: number; step: number; unit: string; def: number; question: string };
  steps: readonly string[];
}

export type ScreenKind = 'question' | 'interstitial' | 'account' | 'express' | 'building' | 'summary' | 'detail' | 'plan';

export interface Screen {
  id: string;
  kind: ScreenKind;
  /** Section name, or the group for non-question screens. */
  group: string;
  question?: QuestionDef;
  section?: SectionDef;
  interstitial?: InterstitialDef;
  /** On this person's current path. */
  on: boolean;
  /** Detail screens (R1 to R6) are opened from the summary, never stepped through. */
  detail?: boolean;
}

export type IntakeMode = 'quick' | 'full';

export interface ProposedArea {
  area: AreaKey;
  label: string;
  critical: boolean;
  floor?: string;
}

export interface ProposedPillar {
  pillar: PillarName;
  label: string;
  enabled: boolean;
  areas: ProposedArea[];
}
