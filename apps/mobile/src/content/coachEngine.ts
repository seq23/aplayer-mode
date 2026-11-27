// The line under a coaching reply that says whether an AI model was involved (promise audit
// 27 Nov 2026: a scripted fallback after a model call used to say "no AI model saw your words").
export function coachEngineLine(reply: { engine: 'scripted' | 'model'; modelSaw?: boolean }): string {
  if (reply.engine === 'model') return 'Worded by a privacy-approved AI model; the steps are APM’s own.';
  if (reply.modelSaw !== false) return 'Answered by APM’s built-in coaching steps. A privacy-approved AI model was asked to word it, but its answer was not used.';
  return 'Answered by APM’s built-in coaching steps: no AI model saw your words.';
}
