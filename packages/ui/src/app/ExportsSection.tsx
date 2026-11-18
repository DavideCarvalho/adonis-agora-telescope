import { parseAsInteger, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { useMemo, useState } from 'react';
import { ComboSelect } from '../agora-kit/blocks/combo-field';
import { Button } from '../agora-kit/ui/button';
import { downloadText, entriesToCsv, toPrettyJson } from '../client/export.js';
import { entryTypeOptions } from './entry-type-options.js';
import { ExportIcon } from './icons.js';
import { Input, InputField } from './primitives/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './primitives/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './primitives/table.js';
import { Empty, PageHeader, Panel, SectionTitle } from './ui.js';
import { useMeta, useTelescopeClient } from './use-telescope.js';

const FORMATS = ['json', 'csv'] as const;
type Format = (typeof FORMATS)[number];

interface RecentExport {
  filename: string;
  type: string;
  rows: number;
  format: Format;
  at: string;
}

/** The maximum rows a single export fetches — matches the server's own `/entries` hard cap. */
const MAX_LIMIT = 500;

/**
 * A client-side export workbench: filter the entries feed (type + search), pick a row limit
 * and a format, then download the result as pretty JSON or RFC 4180 CSV. No server export
 * endpoint — this pages the existing `GET /entries` list route in the browser.
 */
export function ExportsSection() {
  const client = useTelescopeClient();
  // The export's filters are in the URL (`#/exports?type=query&q=users&limit=500&format=csv`).
  const [type, setType] = useQueryState('type', parseAsString.withDefault(''));
  const meta = useMeta();
  const typeOptions = useMemo(() => entryTypeOptions(meta.data), [meta.data]);
  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const [limit, setLimit] = useQueryState('limit', parseAsInteger.withDefault(200));
  const [format, setFormat] = useQueryState(
    'format',
    parseAsStringLiteral(FORMATS).withDefault('json'),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentExport[]>([]);

  const runExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const entries = await client.listEntries({
        ...(type ? { type } : {}),
        ...(search ? { search } : {}),
        first: Math.max(1, Math.min(MAX_LIMIT, limit)),
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `telescope-export-${type || 'all'}-${stamp}.${format}`;
      if (format === 'json') {
        downloadText(filename, toPrettyJson(entries), 'application/json');
      } else {
        downloadText(filename, entriesToCsv(entries), 'text/csv');
      }
      setRecent((prev) =>
        [
          {
            filename,
            type: type || 'all',
            rows: entries.length,
            format,
            at: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 10),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Exports"
        description="Download filtered entries as JSON or CSV, built in the browser from the entries feed."
      />
      <Panel>
        <SectionTitle title="New export" hint={`up to ${MAX_LIMIT} rows`} />
        <div className="flex flex-wrap items-center gap-2.5">
          <ComboSelect
            aria-label="export type"
            className="min-w-44"
            placeholder="All types"
            options={typeOptions}
            value={type || null}
            onValueChange={(next) => void setType(next ?? '')}
          />
          <InputField
            type="search"
            placeholder="Search summary + content…"
            aria-label="export search"
            value={search}
            onChange={(e) => void setSearch(e.target.value)}
            containerClassName="w-full sm:w-auto sm:min-w-[220px]"
          />
          <Input
            type="number"
            min={1}
            max={MAX_LIMIT}
            aria-label="row limit"
            value={limit}
            onChange={(e) => void setLimit(Number(e.target.value) || 1)}
            className="mono tnum w-[90px]"
          />
          <Select
            value={format}
            onValueChange={(next) => void setFormat(next === 'csv' ? 'csv' : 'json')}
          >
            <SelectTrigger aria-label="export format">
              <SelectValue>{(v: string | null) => (v === 'csv' ? 'CSV' : 'JSON')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="csv">CSV</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={runExport} disabled={busy}>
            <ExportIcon />
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-xs text-bad">
            {error}
          </p>
        )}
      </Panel>

      <Panel>
        <SectionTitle title="Recent exports" hint="this session" />
        {recent.length === 0 ? (
          <Empty>Nothing exported yet.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Filename</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((r) => (
                <TableRow key={r.filename}>
                  <TableCell className="mono text-fg-2">{r.filename}</TableCell>
                  <TableCell>{r.type}</TableCell>
                  <TableCell className="tnum text-right">{r.rows}</TableCell>
                  <TableCell className="mono">{r.format.toUpperCase()}</TableCell>
                  <TableCell className="mono text-faint" title={r.at}>
                    {new Date(r.at).toLocaleTimeString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
