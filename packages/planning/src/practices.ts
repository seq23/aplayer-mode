import type { AreaKey, PillarName } from '@apm/domain';
import { AREA_PILLAR } from '@apm/domain';
import type { MvdAction } from './goal-plan-types.js';

/**
 * Mind and Spirit practice libraries (owner decision 7 Oct 2026).
 *
 * Design principle (binding): APM GENERATES the concrete thing (the prompt, the script,
 * the count, the order). The user never designs a practice or faces a blank page. Every
 * practice therefore has a generated daily action, a cadence and a Minimum Viable Day
 * floor of a few minutes or less.
 *
 * The content is general, widely taught practice (expressive journaling, paced
 * breathing, a three-good-things gratitude note, a phone-free outdoor pause, a weekly
 * review). Nothing here is proprietary, clinical or religious instruction: faith wording
 * appears only when the user chose Faith or welcomed faith language, and therapy is
 * tracked as an appointment the user already has, never offered as treatment.
 */

export type PracticeCadence = 'daily' | 'few' | 'weekly';

export type MindPracticeKey = 'journaling' | 'reading' | 'learning_plan' | 'focus_hygiene' | 'therapy' | 'weekly_reflection';
export type SpiritPracticeKey = 'faith' | 'meditation' | 'gratitude' | 'nature' | 'service' | 'family_time';
export type PracticeKey = MindPracticeKey | SpiritPracticeKey;

export interface PracticeDefinition {
  key: PracticeKey;
  pillar: Extract<PillarName, 'mind' | 'spirit'>;
  area: AreaKey;
  label: string;
  /** One line shown on the summary: what APM takes off her plate. */
  plate: string;
  /** The default cadence when the user gave none. */
  defaultCadence: PracticeCadence;
  /** True when the practice uses faith language (shown only with consent). */
  faith?: boolean;
}

export const MIND_PRACTICES: Readonly<Record<MindPracticeKey, PracticeDefinition>> = {
  journaling: { key: 'journaling', pillar: 'mind', area: 'mental_health', label: 'Journaling', plate: 'APM writes the prompt every day. You never face a blank page.', defaultCadence: 'daily' },
  reading: { key: 'reading', pillar: 'mind', area: 'learning', label: 'Reading', plate: 'Ten pages or one chapter a day, in the format you actually use.', defaultCadence: 'daily' },
  learning_plan: { key: 'learning_plan', pillar: 'mind', area: 'learning', label: 'Learning plan', plate: 'A four-week plan for what you want to learn, one step a week.', defaultCadence: 'weekly' },
  focus_hygiene: { key: 'focus_hygiene', pillar: 'mind', area: 'focus', label: 'Focus & screen boundaries', plate: 'Your phone and screen lines, turned into one small move a day.', defaultCadence: 'daily' },
  therapy: { key: 'therapy', pillar: 'mind', area: 'mental_health', label: 'Therapy or counselling sessions', plate: 'Your sessions stay booked and you arrive with one thing to say.', defaultCadence: 'weekly' },
  weekly_reflection: { key: 'weekly_reflection', pillar: 'mind', area: 'mental_health', label: 'Weekly reflection', plate: 'Three fixed questions on your review day. Ten minutes, already written.', defaultCadence: 'weekly' },
};

export const SPIRIT_PRACTICES: Readonly<Record<SpiritPracticeKey, PracticeDefinition>> = {
  faith: { key: 'faith', pillar: 'spirit', area: 'faith', label: 'Faith', plate: 'Prayer time, a short reading, worship and community, already placed in your week.', defaultCadence: 'daily', faith: true },
  meditation: { key: 'meditation', pillar: 'spirit', area: 'meditation', label: 'Meditation & mindfulness', plate: 'A guided breathing script with the counts written out. Just follow it.', defaultCadence: 'daily' },
  gratitude: { key: 'gratitude', pillar: 'spirit', area: 'gratitude', label: 'Gratitude', plate: 'Three lines a day. APM gives you the three prompts.', defaultCadence: 'daily' },
  nature: { key: 'nature', pillar: 'spirit', area: 'nature', label: 'Nature & stillness', plate: 'Ten phone-free minutes outside, with what to notice spelled out.', defaultCadence: 'daily' },
  service: { key: 'service', pillar: 'spirit', area: 'service', label: 'Service & giving', plate: 'One concrete kind act, chosen for you, a few times a week.', defaultCadence: 'few' },
  family_time: { key: 'family_time', pillar: 'spirit', area: 'family', label: 'Family & relationships', plate: 'Protected family time is booked first and defended like a board meeting.', defaultCadence: 'daily' },
};

export const PRACTICE_LIBRARY: Readonly<Record<PracticeKey, PracticeDefinition>> = { ...MIND_PRACTICES, ...SPIRIT_PRACTICES };

/** The options of the one-tap "What feeds your spirit?" question (family lives in Home front). */
export const SPIRIT_QUESTION_OPTIONS: ReadonlyArray<[SpiritPracticeKey, string]> = [
  ['faith', 'Faith: prayer, scripture, worship, community'],
  ['meditation', 'Meditation or mindfulness'],
  ['gratitude', 'Gratitude'],
  ['nature', 'Nature and stillness'],
  ['service', 'Service and giving'],
];

// ---------------------------------------------------------------------------
// Generated content
// ---------------------------------------------------------------------------

/** 28 journaling prompts (four weeks), rotated by day. Short, concrete, non-clinical. */
export const JOURNAL_PROMPTS: readonly string[] = [
  'What is taking up the most space in my head right now, and what is the smallest next step on it?',
  'What went right yesterday, even a little?',
  'What am I avoiding, and what would the first five minutes of it look like?',
  'What would make today a good day if only one thing happened?',
  'What did I say yes to that I want to say no to?',
  'Which worry is about something I control, and which is not?',
  'What gave me energy this week, and what drained it?',
  'What would I tell a friend who had my exact day?',
  'What am I proud of that nobody saw?',
  'What is one thing I keep re-deciding that I could decide once?',
  'Where did I keep a promise to myself recently?',
  'What feeling showed up most yesterday, and what set it off?',
  'What can I drop this week without anything bad happening?',
  'Who helped me lately, and have I told them?',
  'What does rested look like for me this week?',
  'What is one boundary that would make tomorrow easier?',
  'What story am I telling myself about a recent miss? What is the kinder, true version?',
  'What is the one conversation I need to have, and the first sentence of it?',
  'What did I learn from the last hard day?',
  'What am I looking forward to, even something small?',
  'What would I do today if I trusted the plan?',
  'Which thought keeps looping? Write it down once so it can stop.',
  'What would make my evening easier, decided now?',
  'What is working that I should keep doing?',
  'What am I carrying that belongs to someone else?',
  'What is one thing I can finish today?',
  'What did my body tell me today?',
  'Looking back at this week: what is the one change for next week?',
];

/** Gratitude prompt triplets, rotated by day: one person, one moment, one thing. */
export const GRATITUDE_PROMPTS: ReadonlyArray<readonly [string, string, string]> = [
  ['One person who made today lighter', 'One moment that went right', 'One thing you have that you once wanted'],
  ['Someone you can count on', 'Something you saw or heard that you liked', 'Something your body did for you'],
  ['A person who taught you something', 'A small win from yesterday', 'Something in your home you are glad of'],
  ['Someone who made you laugh recently', 'A problem that turned out smaller than you feared', 'A skill you have now'],
  ['A person you have not thanked yet', 'A meal or drink you enjoyed', 'A place you like being'],
  ['Someone who believes in you', 'A moment of calm today', 'Something you learned this week'],
  ['A person you helped', 'Something that went to plan', 'Something you are looking forward to'],
];

/** Guided breath scripts with the counts written out (secular). Rotated by day. */
export const MEDITATION_SCRIPTS: ReadonlyArray<{ name: string; minutes: number; steps: readonly string[] }> = [
  {
    name: 'Box breathing',
    minutes: 4,
    steps: [
      'Sit with both feet on the floor. Let your shoulders drop.',
      'Breathe in through your nose for a count of 4.',
      'Hold for 4.',
      'Breathe out through your mouth for 4.',
      'Hold for 4. That is one round.',
      'Do 8 rounds. If counting slips, start again at 1. That still counts.',
    ],
  },
  {
    name: 'Long exhale',
    minutes: 3,
    steps: [
      'Sit or lie down. One hand on your belly.',
      'Breathe in for 4, letting the belly rise.',
      'Breathe out slowly for 6.',
      'Repeat for 12 breaths.',
      'Finish with one normal breath and notice how you feel. No need to change it.',
    ],
  },
  {
    name: 'Body scan',
    minutes: 5,
    steps: [
      'Sit or lie down and close your eyes if that feels okay.',
      'Take 3 slow breaths: in for 4, out for 6.',
      'Notice your feet for 3 breaths. Then your legs for 3 breaths.',
      'Then your belly and chest for 3 breaths. Then your shoulders and jaw for 3 breaths.',
      'Let anything tight soften a little on each out-breath.',
      'Finish with 3 slow breaths and open your eyes.',
    ],
  },
  {
    name: 'Counted breaths',
    minutes: 3,
    steps: [
      'Sit comfortably. Breathe normally through your nose.',
      'Count each out-breath: 1, 2, 3, up to 10.',
      'At 10, start again at 1. Do 3 sets of 10.',
      'When your mind wanders, notice it and start again at 1. That is the practice.',
    ],
  },
];

/** What to notice outside (secular 5-4-3-2-1 grounding). */
export const NATURE_STEPS: readonly string[] = [
  'Leave your phone inside or on silent in a pocket.',
  'Step outside: a garden, a street with trees, a balcony or an open window all count.',
  'Notice 5 things you can see, 4 you can hear, 3 you can feel, 2 you can smell, 1 you are glad of.',
  'Walk slowly or stand still for the rest of the 10 minutes.',
];

export const SERVICE_ACTS: readonly string[] = [
  'Text someone who is going through a hard time: "Thinking of you. No need to reply."',
  'Give 15 minutes of help to someone at work or at home without being asked.',
  'Write a short thank-you note to someone who helped you.',
  'Pass on something useful: an intro, a recommendation or a book you finished.',
  'Do one chore that someone else in your home usually does.',
  'Check in on a neighbour, an older relative or a friend who lives alone.',
];

export const WEEKLY_REFLECTION_QUESTIONS: readonly string[] = [
  'What worked this week?',
  'What drained me this week?',
  'What is the one change for next week?',
];

export type LearningTopic = 'leadership' | 'money' | 'health' | 'craft' | 'faith' | 'parenting';
export type LearningModality = 'read' | 'audio' | 'video' | 'doing' | 'course';

const LEARNING_FOCUS: Readonly<Record<LearningTopic, { skill: string; weeks: readonly [string, string, string, string] }>> = {
  leadership: {
    skill: 'giving clear feedback and running a useful 1:1',
    weeks: [
      'Pick one book, course or podcast series on feedback and 1:1s, and put it where you will see it',
      'Use one idea from it in one real conversation this week',
      'Ask one person how a recent conversation with you landed',
      'Write the three things you will keep doing, on one page',
    ],
  },
  money: {
    skill: 'how your money flows: essentials, buffer, debt order',
    weeks: [
      'Pick one beginner personal-finance book or course (no product sales) and start it',
      'Write your monthly essentials on one page',
      'Write your debts in the order you will pay them',
      'Write your one money rule for the next 90 days',
    ],
  },
  health: {
    skill: 'sleep and daily movement basics',
    weeks: [
      'Pick one evidence-based book or course on sleep or movement and start it',
      'Try one sleep or movement change for 5 days',
      'Note what changed in energy, in one line a day',
      'Keep the change that helped and write it as a rule',
    ],
  },
  craft: {
    skill: 'one core technique, practised daily',
    weeks: [
      'Name the one technique to get better at and find one lesson on it',
      'Practise it in short daily reps',
      'Make one small piece that uses it',
      'Compare it with week 1 and write what improved',
    ],
  },
  faith: {
    skill: 'one book of scripture or one devotional series, read slowly',
    weeks: [
      'Choose the book or devotional series and the time of day you will read',
      'Read daily and write one line about what stood out',
      'Talk about one passage with someone',
      'Write the one idea you are carrying into next month',
    ],
  },
  parenting: {
    skill: 'calm routines and connection',
    weeks: [
      'Pick one well-reviewed parenting book or course and start it',
      'Try one routine change at home for 5 days',
      'Spend 10 minutes of one-on-one time with each child this week',
      'Keep what worked and write it down for the family',
    ],
  },
};

function modalityStep(modality: LearningModality | undefined, topicSkill: string): { title: string; minutes: number; mvd: MvdAction } {
  switch (modality) {
    case 'audio':
      return { title: `Listen to one chapter (about 15 minutes) of an audiobook or podcast on ${topicSkill}`, minutes: 15, mvd: { title: 'Listen for 2 minutes', output: 'Two minutes listened', durationMinutes: 2 } };
    case 'video':
      return { title: `Watch one 15-minute lesson on ${topicSkill}`, minutes: 15, mvd: { title: 'Watch 2 minutes of the lesson', output: 'Two minutes watched', durationMinutes: 2 } };
    case 'doing':
      return { title: `Practise ${topicSkill} for 15 minutes, hands on`, minutes: 15, mvd: { title: 'Practise for 2 minutes', output: 'Two minutes practised', durationMinutes: 2 } };
    case 'course':
      return { title: `Do one lesson of your course on ${topicSkill}`, minutes: 20, mvd: { title: 'Open the course and do 2 minutes', output: 'Course opened and two minutes done', durationMinutes: 2 } };
    default:
      return { title: `Read 10 pages, or one chapter, on ${topicSkill}`, minutes: 15, mvd: { title: 'Read one page', output: 'One page read', durationMinutes: 2 } };
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface PracticeInput {
  /** Answers already mapped to practices (see `selectMindPractices` / `selectSpiritPractices`). */
  mind: MindPracticeKey[];
  spirit: SpiritPracticeKey[];
  cadence?: PracticeCadence;
  learningTopic?: LearningTopic;
  learningModality?: LearningModality;
  /** Line ids from the intake "lines" question (screen / phone boundaries live there). */
  lines?: string[];
  /** Fixed commitments (worship) and Home front protected moments. */
  fixed?: string[];
  protectedMoments?: string[];
  faithLanguage?: boolean;
}

/** One generated practice, as it appears on the summary and on Today. */
export interface PracticeAction {
  key: PracticeKey;
  pillar: 'mind' | 'spirit';
  area: AreaKey;
  label: string;
  cadence: PracticeCadence;
  /** Today's concrete action. */
  title: string;
  /** Spelled-out steps (scripts, counts, prompts), when the action has them. */
  steps: string[];
  output: string;
  minutes: number;
  /** The Minimum Viable Day floor for this practice. */
  floor: MvdAction;
  /** Rotating titles (the engine picks one per day). */
  rotation?: string[];
}

const dayNumber = (date: string) => Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 86_400_000);
const pick = <T>(items: readonly T[], date: string): T => items[((dayNumber(date) % items.length) + items.length) % items.length]!;

function journaling(date: string, cadence: PracticeCadence): PracticeAction {
  const prompt = pick(JOURNAL_PROMPTS, date);
  return {
    key: 'journaling', pillar: 'mind', area: 'mental_health', label: MIND_PRACTICES.journaling.label, cadence,
    title: `Journal for 5 minutes: ${prompt}`,
    steps: [prompt, 'Write without fixing anything. Five minutes, then stop.'],
    output: 'A few lines written', minutes: 5,
    floor: { title: 'Write one line in your journal', output: 'One line written', durationMinutes: 1 },
    rotation: JOURNAL_PROMPTS.map((p) => `Journal for 5 minutes: ${p}`),
  };
}

function reading(input: PracticeInput, cadence: PracticeCadence): PracticeAction {
  const topic = input.learningTopic ? LEARNING_FOCUS[input.learningTopic].skill : 'a book you chose for this season';
  const step = modalityStep(input.learningModality, topic);
  return {
    key: 'reading', pillar: 'mind', area: 'learning', label: MIND_PRACTICES.reading.label, cadence,
    title: step.title, steps: [], output: 'Done and logged', minutes: step.minutes, floor: step.mvd,
  };
}

function learningPlan(input: PracticeInput, date: string, startDate: string, cadence: PracticeCadence): PracticeAction | undefined {
  if (!input.learningTopic) return undefined;
  const focus = LEARNING_FOCUS[input.learningTopic];
  const week = Math.min(3, Math.max(0, Math.floor((dayNumber(date) - dayNumber(startDate)) / 7)));
  return {
    key: 'learning_plan', pillar: 'mind', area: 'learning', label: MIND_PRACTICES.learning_plan.label, cadence,
    title: `Learning plan, week ${week + 1} of 4: ${focus.weeks[week]}`,
    steps: focus.weeks.map((step, i) => `Week ${i + 1}: ${step}`),
    output: 'This week\'s learning step done', minutes: 20,
    floor: { title: `Spend 2 minutes on ${focus.skill}`, output: 'Two minutes on the learning plan', durationMinutes: 2 },
  };
}

function focusHygiene(input: PracticeInput, cadence: PracticeCadence): PracticeAction {
  const lines = input.lines ?? [];
  const title = lines.includes('no_screens_8')
    ? 'At 8 PM, put your phone on the charger outside the bedroom and switch the screens off'
    : lines.includes('phone_bedroom')
      ? 'Tonight, charge your phone outside the bedroom'
      : lines.includes('no_meet_10')
        ? 'Keep the block before 10 AM meeting-free: notifications off, one task only'
        : 'Put your phone in another room for your first focus block';
  return {
    key: 'focus_hygiene', pillar: 'mind', area: 'focus', label: MIND_PRACTICES.focus_hygiene.label, cadence,
    title, steps: [], output: 'Boundary kept', minutes: 5,
    floor: { title: 'Put your phone in another room for 15 minutes', output: 'Fifteen phone-free minutes', durationMinutes: 1 },
  };
}

function therapy(cadence: PracticeCadence): PracticeAction {
  return {
    key: 'therapy', pillar: 'mind', area: 'mental_health', label: MIND_PRACTICES.therapy.label, cadence,
    title: 'Check your next therapy or counselling session is booked, and write one thing to bring to it',
    steps: ['If it is not booked, book it now.', 'Write one thing you want to talk about.'],
    output: 'Session booked and one topic written', minutes: 5,
    floor: { title: 'Write one line to bring to your next session', output: 'One line written', durationMinutes: 1 },
  };
}

function weeklyReflection(): PracticeAction {
  return {
    key: 'weekly_reflection', pillar: 'mind', area: 'mental_health', label: MIND_PRACTICES.weekly_reflection.label, cadence: 'weekly',
    title: `Weekly reflection, 10 minutes: ${WEEKLY_REFLECTION_QUESTIONS.join(' ')}`,
    steps: [...WEEKLY_REFLECTION_QUESTIONS], output: 'Three answers written', minutes: 10,
    floor: { title: 'Write one sentence about the week', output: 'One sentence written', durationMinutes: 1 },
  };
}

function faith(input: PracticeInput, cadence: PracticeCadence): PracticeAction {
  const worship = (input.fixed ?? []).includes('worship') || (input.lines ?? []).includes('worship');
  return {
    key: 'faith', pillar: 'spirit', area: 'faith', label: SPIRIT_PRACTICES.faith.label, cadence,
    title: '5 minutes of prayer, then read one short passage from your scripture or devotional',
    steps: [
      'Prayer time: 5 minutes, in your own words or a prayer you know.',
      'Read one short passage from your scripture or devotional and write one line about it.',
      worship ? 'Worship is on your week as a protected block.' : 'Once a week: worship or a gathering with your faith community.',
      'Once a week: message one person from your faith community.',
    ],
    output: 'Prayer and reading done', minutes: 10,
    floor: { title: '1 minute of prayer or silence', output: 'One minute of prayer or silence', durationMinutes: 1 },
  };
}

function meditation(date: string, cadence: PracticeCadence): PracticeAction {
  const script = pick(MEDITATION_SCRIPTS, date);
  return {
    key: 'meditation', pillar: 'spirit', area: 'meditation', label: SPIRIT_PRACTICES.meditation.label, cadence,
    title: `${script.name}, ${script.minutes} minutes (guided, counts below)`,
    steps: [...script.steps], output: 'Script followed once', minutes: script.minutes,
    floor: { title: '3 slow breaths: in for 4, out for 6', output: 'Three slow breaths', durationMinutes: 1 },
    rotation: MEDITATION_SCRIPTS.map((s) => `${s.name}, ${s.minutes} minutes (guided, counts below)`),
  };
}

function gratitude(date: string, cadence: PracticeCadence): PracticeAction {
  const prompts = pick(GRATITUDE_PROMPTS, date);
  return {
    key: 'gratitude', pillar: 'spirit', area: 'gratitude', label: SPIRIT_PRACTICES.gratitude.label, cadence,
    title: `Write 3 lines of gratitude: ${prompts.join('; ')}`,
    steps: [...prompts], output: 'Three lines written', minutes: 3,
    floor: { title: 'Write one line: one thing that went right', output: 'One line written', durationMinutes: 1 },
    rotation: GRATITUDE_PROMPTS.map((p) => `Write 3 lines of gratitude: ${p.join('; ')}`),
  };
}

function nature(cadence: PracticeCadence): PracticeAction {
  return {
    key: 'nature', pillar: 'spirit', area: 'nature', label: SPIRIT_PRACTICES.nature.label, cadence,
    title: '10 phone-free minutes outside: notice 5 things you see, 4 you hear, 3 you feel',
    steps: [...NATURE_STEPS], output: 'Ten minutes outside', minutes: 10,
    floor: { title: 'Step outside for 1 minute and take 3 slow breaths', output: 'One minute outside', durationMinutes: 1 },
  };
}

function service(date: string, cadence: PracticeCadence): PracticeAction {
  const act = pick(SERVICE_ACTS, date);
  return {
    key: 'service', pillar: 'spirit', area: 'service', label: SPIRIT_PRACTICES.service.label, cadence,
    title: `One kind act: ${act}`, steps: [act], output: 'Kind act done', minutes: 15,
    floor: { title: 'Send one kind message to someone', output: 'One kind message sent', durationMinutes: 2 },
    rotation: SERVICE_ACTS.map((a) => `One kind act: ${a}`),
  };
}

function familyTime(input: PracticeInput, cadence: PracticeCadence): PracticeAction {
  const moments = input.protectedMoments ?? [];
  const when = moments.includes('dinner') ? 'dinner' : moments.includes('bedtime') ? 'bedtime' : moments.includes('school_run') ? 'the school run' : 'one protected moment';
  return {
    key: 'family_time', pillar: 'spirit', area: 'family', label: SPIRIT_PRACTICES.family_time.label, cadence,
    title: `Protected family time at ${when}: 20 minutes, phone in another room`,
    steps: [], output: 'Family time protected', minutes: 20,
    floor: { title: 'One protected family touchpoint for 10 minutes, phone away', output: 'Touchpoint done', durationMinutes: 10 },
  };
}

/** Mind practices from the intake answers (pre-selected, never forced). */
export function selectMindPractices(answers: { practices?: string[]; learning?: string; lines?: string[]; patterns?: string[] }): MindPracticeKey[] {
  const out: MindPracticeKey[] = [];
  const practices = answers.practices ?? [];
  if (practices.includes('journaling')) out.push('journaling');
  if (practices.includes('reading')) out.push('reading');
  if (answers.learning && answers.learning !== 'none') out.push('learning_plan');
  const lines = answers.lines ?? [];
  if (lines.some((l) => ['no_screens_8', 'phone_bedroom', 'no_meet_10'].includes(l)) || (answers.patterns ?? []).includes('scroll')) out.push('focus_hygiene');
  if (practices.includes('therapy')) out.push('therapy');
  out.push('weekly_reflection');
  // Mind is on for everyone: with nothing chosen, journaling (one line, prompt supplied) is the default.
  if (!out.some((k) => k !== 'weekly_reflection')) out.unshift('journaling');
  return out;
}

/** "What feeds your spirit?" pre-ticks from the practices answer and fixed worship. */
export function preselectSpiritPractices(answers: { practices?: string[]; fixed?: string[]; helps?: string[] }): SpiritPracticeKey[] {
  const out: SpiritPracticeKey[] = [];
  const practices = answers.practices ?? [];
  if (practices.includes('prayer') || (answers.fixed ?? []).includes('worship')) out.push('faith');
  if (practices.includes('meditation')) out.push('meditation');
  if (practices.includes('gratitude')) out.push('gratitude');
  return out;
}

/** Faith wording is used only when the user chose Faith or welcomed faith language. */
export function faithLanguageAllowed(spirit: readonly string[], helps: readonly string[] = []): boolean {
  return spirit.includes('faith') || helps.includes('faith');
}

/**
 * Today's generated practices. `startDate` anchors the learning plan's weeks. Practices
 * the user did not choose are never generated; faith practice is dropped without consent.
 */
export function generatePractices(input: PracticeInput, date: string, startDate = date): PracticeAction[] {
  const out: PracticeAction[] = [];
  const cadenceOf = (def: PracticeDefinition): PracticeCadence => (def.defaultCadence === 'daily' ? input.cadence ?? 'daily' : def.defaultCadence);
  for (const key of input.mind) {
    const def = MIND_PRACTICES[key];
    const c = cadenceOf(def);
    if (key === 'journaling') out.push(journaling(date, c));
    if (key === 'reading') out.push(reading(input, c));
    if (key === 'learning_plan') { const p = learningPlan(input, date, startDate, c); if (p) out.push(p); }
    if (key === 'focus_hygiene') out.push(focusHygiene(input, c));
    if (key === 'therapy') out.push(therapy(c));
    if (key === 'weekly_reflection') out.push(weeklyReflection());
  }
  const faithOk = faithLanguageAllowed(input.spirit, input.faithLanguage ? ['faith'] : []);
  for (const key of input.spirit) {
    const def = SPIRIT_PRACTICES[key];
    const c = cadenceOf(def);
    if (key === 'faith' && faithOk) out.push(faith(input, c));
    if (key === 'meditation') out.push(meditation(date, c));
    if (key === 'gratitude') out.push(gratitude(date, c));
    if (key === 'nature') out.push(nature(c));
    if (key === 'service') out.push(service(date, c));
    if (key === 'family_time') out.push(familyTime(input, c));
  }
  return out;
}

/** Weekday indexes (0 = Sunday) a cadence runs on; `few` = Mon, Wed, Fri. */
export function cadenceDays(cadence: PracticeCadence, reviewDay = 0): number[] {
  if (cadence === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (cadence === 'few') return [1, 3, 5];
  return [reviewDay];
}

/** True when a practice of this cadence is due on the given date. */
export function practiceDueOn(cadence: PracticeCadence, date: string, reviewDay = 0): boolean {
  return cadenceDays(cadence, reviewDay).includes(new Date(`${date}T00:00:00.000Z`).getUTCDay());
}

export function practicePillar(area: AreaKey): PillarName {
  return AREA_PILLAR[area];
}
