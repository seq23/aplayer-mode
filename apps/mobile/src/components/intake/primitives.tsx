import { StyleSheet } from 'react-native';
import { spacing } from '../../theme';

/**
 * Intake building blocks (docs/34 §4.1, §6.1) are the design system's own primitives
 * (src/components/ui.tsx): answer cards ≥ 64 pt, chips ≥ 44 pt, selection shown by a check
 * as well as color, screen-reader state on every control.
 */
export { AnswerCard as OptionButton, Chip, Muted, PlateLine, ProgressBar, Stepper } from '../ui';

/** Layout only (no color, no type): the intake's vertical rhythm and chip wrap. */
export const intakeStyles = StyleSheet.create({
  stack: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
