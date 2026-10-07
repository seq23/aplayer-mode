import { createElement } from 'react';
import { radius, spacing, tap, useTheme } from '../theme';
import { TimeField } from './ui';

/** Web: the browser's own time input (keyboard and screen-reader friendly), themed. */
export function TimePicker({ label, value, onChange, placeholder = 'Not set', allowClear = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowClear?: boolean;
}) {
  const { colors, type, scheme } = useTheme();
  const { maxFontSizeMultiplier: _unused, ...font } = type.body;
  const input = createElement('input', {
    type: 'time',
    value,
    'aria-label': label,
    placeholder,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    style: {
      ...font, fontSize: 17, lineHeight: `${font.lineHeight ?? 24}px`, height: tap.button, boxSizing: 'border-box', width: '100%', color: colors.ink, backgroundColor: colors.surface,
      border: `1px solid ${colors.lineStrong}`, borderRadius: radius.md, padding: `0 ${spacing.md}px`, colorScheme: scheme,
    },
  });
  return <TimeField label={label} value={value} placeholder={placeholder} open={false} onClear={allowClear && value ? () => onChange('') : undefined}>{input}</TimeField>;
}
