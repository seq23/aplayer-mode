import { Body, Card, Eyebrow, Muted, Stack } from './ui';
import { TESTIMONIALS, TESTIMONIALS_TITLE, type Testimonial } from '../content/testimonials';

/** Real quotes from public/testimonials.json; renders nothing while that list is empty. */
export function Testimonials({ items = TESTIMONIALS }: { items?: readonly Testimonial[] }) {
  if (items.length === 0) return null;
  return (
    <Stack gap="sm">
      <Eyebrow>{TESTIMONIALS_TITLE}</Eyebrow>
      {items.map((t) => (
        <Card key={`${t.name}:${t.quote.slice(0, 24)}`}>
          <Body>{`“${t.quote}”`}</Body>
          <Muted>{t.context ? `${t.name} · ${t.context}` : t.name}</Muted>
        </Card>
      ))}
    </Stack>
  );
}
