// Area choices, grouped by pillar (Mind, Body, Spirit): the one list the Goals tab and the
// Drafting Room offer. Areas are what the engine plans and floors; pillars are the roll-up.
import { AREA_KEYS, AREA_LABELS, AREA_PILLAR, PILLAR_LABELS, type AreaKey } from '@apm/domain';

export const AREA_OPTIONS: Array<{ id: AreaKey; label: string }> = AREA_KEYS.map((area) => ({ id: area, label: `${PILLAR_LABELS[AREA_PILLAR[area]]} · ${AREA_LABELS[area]}` }));

export function areaDisplay(area: string | undefined): string {
  if (!area || !(area in AREA_PILLAR)) return 'Not set';
  const key = area as AreaKey;
  return `${PILLAR_LABELS[AREA_PILLAR[key]]} · ${AREA_LABELS[key]}`;
}
