import type { EntrySummary } from './types.js';

/** Pretty-printed JSON of a set of entry summaries, for the exports workbench download. */
export function toPrettyJson(entries: EntrySummary[]): string {
  return JSON.stringify(entries, null, 2);
}

/** RFC 4180 field escaping: quote (and double any embedded quotes) whenever the value contains a
 *  comma, quote, or newline. */
export function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const CSV_HEADER = [
  'id',
  'type',
  'createdAt',
  'durationMs',
  'tags',
  'familyHash',
  'traceId',
  'summary',
];

/** `EntrySummary[]` → an RFC 4180 CSV string (CRLF rows, quoted/escaped fields). */
export function entriesToCsv(entries: EntrySummary[]): string {
  const rows = entries.map((e) =>
    [
      e.id,
      e.type,
      e.createdAt,
      e.durationMs === null || e.durationMs === undefined ? '' : String(e.durationMs),
      e.tags.join('; '),
      e.familyHash ?? '',
      e.traceId ?? '',
      e.summary,
    ]
      .map(csvCell)
      .join(','),
  );
  return [CSV_HEADER.join(','), ...rows].join('\r\n');
}

/** Trigger a browser download of `content` as `filename` via a throwaway object URL + anchor click. */
export function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
