// Hands the person their data export (promise audit 27 Nov 2026: the screen used to fetch the
// export and keep only its timestamp, so "take a copy" gave no copy). Pure on purpose: the screen
// passes the platform pieces in, so a test can prove each path without React Native.

export type ExportHandoff = 'downloaded' | 'shared' | 'dismissed';

export type ExportDeps = {
  /** The browser app: the file downloads. */
  web: boolean;
  /** Saves `text` as a file called `name` (browser only). */
  download?: (name: string, text: string) => void;
  /** Opens the phone's share sheet with the export (React Native Share.share). */
  share?: (name: string, text: string) => Promise<{ action: string }>;
};

export function exportFileName(generatedAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(generatedAt)?.[0] ?? 'today';
  return `a-player-mode-export-${day}.json`;
}

/** Throws when the platform cannot hand a file over; never reports a copy that was not given. */
export async function handOverExport(deps: ExportDeps, data: unknown, generatedAt: string): Promise<ExportHandoff> {
  const text = JSON.stringify(data, null, 2);
  if (!text || text === '{}' || text === 'null') throw new Error('export_empty');
  const name = exportFileName(generatedAt);
  if (deps.web) {
    if (!deps.download) throw new Error('export_download_unavailable');
    deps.download(name, text);
    return 'downloaded';
  }
  if (!deps.share) throw new Error('export_share_unavailable');
  const result = await deps.share(name, text);
  return result.action === 'dismissedAction' ? 'dismissed' : 'shared';
}

export function exportMessage(handoff: ExportHandoff, generatedAt: string): string {
  const name = exportFileName(generatedAt);
  if (handoff === 'downloaded') return `Your export is downloaded as ${name}. It holds everything APM knows about you and a record of everything it did.`;
  if (handoff === 'shared') return 'Your export went where you shared it. It holds everything APM knows about you and a record of everything it did.';
  return 'Your export was made, but the share sheet was closed before it was saved. Tap Generate export to try again.';
}

/** Browser download of a text file. */
export function browserDownload(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
