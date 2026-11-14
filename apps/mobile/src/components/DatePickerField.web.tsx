import { createElement } from 'react';
import { radius, spacing, tap, useTheme } from '../theme';
import { TimeField } from './ui';
import { longDate } from './dateField';

/** Web: the browser's own date input, themed. */
export function DatePicker({ label, value, onChange, placeholder = 'Pick a date', minDate }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minDate?: string;
}) {
  const { colors, type, scheme } = useTheme();
  const { maxFontSizeMultiplier: _unused, ...font } = type.body;
  const input = createElement('input', {
    type: 'date',
    value,
    min: minDate,
    'aria-label': label,
    placeholder,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    style: {
      ...font, fontSize: 17, lineHeight: `${font.lineHeight ?? 24}px`, height: tap.button, boxSizing: 'border-box', width: '100%', color: colors.ink, backgroundColor: colors.surface,
      border: `1px solid ${colors.lineStrong}`, borderRadius: radius.md, padding: `0 ${spacing.md}px`, colorScheme: scheme,
    },
  });
  return <TimeField date label={label} value={value} display={longDate(value)} placeholder={placeholder} open={false}>{input}</TimeField>;
}
