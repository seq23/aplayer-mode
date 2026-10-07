/**
 * The 10-minute in-bed mobility routine (owner decision 7 Oct 2026). Asked of everyone:
 * "Is getting out of bed hard for you?" Yes or Sometimes → APM generates this routine as
 * morning step 1. APM picks the moves and the order; she follows the prompts with her eyes
 * half open. Pilates-style, no equipment. Behavioral only, never treatment.
 *
 * Gentle variant: when the body safety question was answered "Yes, one or more" or
 * "Prefer not to say", every move runs in a small, pain-free range and the two loaded
 * moves (dead bug, glute bridge) are swapped for lighter ones.
 */

export interface BedMove {
  minutes: number;
  move: string;
}

export const BED_ROUTINE: readonly BedMove[] = [
  { minutes: 1, move: 'Belly breathing, knees bent, one hand on your ribs' },
  { minutes: 1, move: 'Pelvic tilts: flatten your low back, then release' },
  { minutes: 1, move: 'Knee hugs: one knee to chest, then the other' },
  { minutes: 1.5, move: 'Supine twist: knees drop side to side, slowly' },
  { minutes: 1.5, move: 'Dead bug, slow: opposite arm and leg reach out and back' },
  { minutes: 1.5, move: 'Glute bridges: lift hips, hold 3 seconds, lower' },
  { minutes: 1.5, move: 'Figure-4 stretch: ankle on opposite knee, each side' },
  { minutes: 1, move: 'Sit on the edge of the bed: cat-cow and shoulder rolls, then stand' },
];

export const BED_ROUTINE_GENTLE: readonly BedMove[] = [
  { minutes: 1, move: 'Belly breathing, knees bent, one hand on your ribs' },
  { minutes: 1, move: 'Small pelvic tilts: a gentle rock of the low back, no strain' },
  { minutes: 1, move: 'Knee hugs, hands behind the knee: only as far as is comfortable' },
  { minutes: 1.5, move: 'Small supine twist: knees drop a few inches side to side' },
  { minutes: 1.5, move: 'Heel slides: slide one heel away and back, then the other' },
  { minutes: 1.5, move: 'Small bridge: lift the hips just off the bed, lower slowly' },
  { minutes: 1.5, move: 'Ankle circles and toe points, each side' },
  { minutes: 1, move: 'Sit on the edge of the bed: slow shoulder rolls, then stand when ready' },
];

export const BED_ROUTINE_STEP = '10-minute in-bed mobility routine (Pilates-style, guided)';
export const BED_ROUTINE_SAFETY = 'Stop anything that hurts.';

export type BedAnswer = 'yes' | 'sometimes' | 'no';
export type BodySafetyAnswer = 'no' | 'yes' | 'skip';

export interface BedRoutine {
  gentle: boolean;
  totalMinutes: number;
  moves: readonly BedMove[];
  note: string;
}

/** Yes or Sometimes switch the routine on; No leaves the morning as it was. */
export function bedRoutineOn(answer: BedAnswer | undefined): boolean {
  return answer === 'yes' || answer === 'sometimes';
}

/** The gentle range applies when the body safety answer is yes or prefer-not-to-say. */
export function bedRoutineGentle(safety: BodySafetyAnswer | undefined): boolean {
  return safety === 'yes' || safety === 'skip';
}

export function generateBedRoutine(answer: BedAnswer | undefined, safety: BodySafetyAnswer | undefined): BedRoutine | undefined {
  if (!bedRoutineOn(answer)) return undefined;
  const gentle = bedRoutineGentle(safety);
  const moves = gentle ? BED_ROUTINE_GENTLE : BED_ROUTINE;
  return {
    gentle,
    moves,
    totalMinutes: moves.reduce((sum, m) => sum + m.minutes, 0),
    note: `APM picked these and the order. You just follow the prompts with your eyes half open.${gentle ? ' Gentle range only: small, comfortable movements.' : ''} ${BED_ROUTINE_SAFETY}`,
  };
}
