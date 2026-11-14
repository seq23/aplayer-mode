import { useState } from 'react';
import { Platform } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useTheme } from '../theme';
import { TimeField } from './ui';
import { isoToLocalDate, localDateToIso, longDate } from './dateField';

/** A native date picker for "YYYY-MM-DD" answers. iOS: the inline calendar; Android: the system dialog. */
export function DatePicker({ label, value, onChange, placeholder = 'Pick a date', minDate }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minDate?: string;
}) {
  const { scheme } = useTheme();
  const [open, setOpen] = useState(false);
  const pick = (event: DateTimePickerEvent, date?: Date) => {
    if (event.type === 'set' && date) onChange(localDateToIso(date));
  };
  const minimumDate = minDate ? isoToLocalDate(minDate) : undefined;
  const press = () => {
    if (Platform.OS === 'android') { DateTimePickerAndroid.open({ value: isoToLocalDate(value), mode: 'date', onChange: pick, ...(minimumDate ? { minimumDate } : {}) }); return; }
    setOpen((v) => !v);
  };
  return (
    <>
      <TimeField date label={label} value={value} display={longDate(value)} placeholder={placeholder} open={open} onPress={press} />
      {open && Platform.OS === 'ios' ? <DateTimePicker value={isoToLocalDate(value)} mode="date" display="inline" themeVariant={scheme} onChange={pick} accessibilityLabel={label} {...(minimumDate ? { minimumDate } : {})} /> : null}
    </>
  );
}
