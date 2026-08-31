import { useState } from 'react';
import { downloadText, entriesToCsv, toPrettyJson } from '../client/export.js';
import { ENTRY_TYPES } from '../client/types.js';
import { Button } from './primitives/button.js';
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
import { Empty, Panel, SectionTitle } from './ui.js';
import { useTelescopeClient } from './use-telescope.js';

type Format = 'json' | 'csv';

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
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(200);
  const [format, setFormat] = useState<Format>('json');
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
        limit: Math.max(1, Math.min(MAX_LIMIT, limit)),
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
      <Panel>
        <SectionTitle title="Exports" hint="download filtered entries as JSON or CSV" />
        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            value={type}
            onValueChange={(next) => setType(typeof next === 'string' ? next : '')}
          >
            <SelectTrigger aria-label="export type" className="min-w-36">
              <SelectValue>{(v: string | null) => (v ? v : 'All types')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All types</SelectItem>
              {ENTRY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <InputField
            type="search"
            placeholder="Search summary + content…"
            aria-label="export search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            containerClassName="min-w-[220px]"
          />
          <Input
            type="number"
            min={1}
            max={MAX_LIMIT}
            aria-label="row limit"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 1)}
            className="tnum w-[90px]"
          />
          <Select
            value={format}
            onValueChange={(next) => setFormat(next === 'csv' ? 'csv' : 'json')}
          >
            <SelectTrigger aria-label="export format">
              <SelectValue>{(v: string | null) => (v === 'csv' ? 'CSV' : 'JSON')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="csv">CSV</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="brand" onClick={runExport} disabled={busy}>
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-bad">{error}</p>}
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
                  <TableCell className="mono">{r.filename}</TableCell>
                  <TableCell>{r.type}</TableCell>
                  <TableCell className="tnum text-right">{r.rows}</TableCell>
                  <TableCell className="mono">{r.format.toUpperCase()}</TableCell>
                  <TableCell className="text-muted-foreground" title={r.at}>
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
