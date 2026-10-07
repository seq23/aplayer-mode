import { useState } from 'react';
import { Platform } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useTheme } from '../theme';
import { TimeField, dateToHHMM, hhmmToDate } from './ui';

/**
 * A native time picker for "HH:MM" settings (docs/35 U11: nobody types a 24-hour clock).
 * iOS opens the wheel under the field; Android opens the system clock dialog. The web build
 * uses TimePickerField.web.tsx (the browser's own time input).
 */
export function TimePicker({ label, value, onChange, placeholder = 'Not set', allowClear = false }: {
  label: string;
  /** "HH:MM" (24-hour), or "" when unset. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowClear?: boolean;
}) {
  const { scheme } = useTheme();
  const [open, setOpen] = useState(false);
  const pick = (event: DateTimePickerEvent, date?: Date) => {
    if (event.type === 'set' && date) onChange(dateToHHMM(date));
  };
  const press = () => {
    if (Platform.OS === 'android') { DateTimePickerAndroid.open({ value: hhmmToDate(value), mode: 'time', onChange: pick }); return; }
    setOpen((v) => !v);
  };
  return (
    <>
      <TimeField label={label} value={value} placeholder={placeholder} open={open} onPress={press} onClear={allowClear && value ? () => onChange('') : undefined} />
      {open && Platform.OS === 'ios' ? <DateTimePicker value={hhmmToDate(value)} mode="time" display="spinner" themeVariant={scheme} onChange={pick} accessibilityLabel={label} /> : null}
    </>
  );
}
