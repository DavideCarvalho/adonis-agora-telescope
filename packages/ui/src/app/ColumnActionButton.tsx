import { useState } from 'react';
import type { ColumnAction } from '../client/types.js';
import { Button } from './primitives/button.js';
import { Dialog } from './primitives/dialog.js';
import { useTelescopeClient } from './use-telescope.js';

/** Substitute `{key}` placeholders from the row; a missing key yields an empty string. */
export function fillText(template: string, row: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = row[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Whether the action applies to this row (its `when` filter). */
export function actionApplies(action: ColumnAction, row: Record<string, unknown>): boolean {
  if (!action.when) return true;
  const value = row[action.when.key];
  return action.when.in.some((candidate) => candidate === value);
}

/** The JSON input for the action, every `{key}` template filled from the row. */
export function actionInput(
  action: ColumnAction,
  row: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(action.input ?? {})) {
    out[name] = fillText(template, row);
  }
  return out;
}

/**
 * A table-cell button that runs an extension action on its row: a confirmation dialog first, then
 * the call; the table reloads on success, and a failure is shown in the dialog.
 */
export function ColumnActionButton({
  ext,
  action,
  row,
  onDone,
}: {
  ext: string;
  action: ColumnAction;
  row: Record<string, unknown>;
  onDone: () => void;
}) {
  const client = useTelescopeClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!actionApplies(action, row)) return <span className="text-muted-foreground">—</span>;

  const run = async () => {
    setBusy(true);
    setError(null);
    const outcome = await client.extAction(ext, action.action, actionInput(action, row));
    setBusy(false);
    if (outcome.ok) {
      setOpen(false);
      onDone();
    } else {
      setError(outcome.message);
    }
  };

  return (
    <>
      <Button
        variant={action.destructive ? 'danger' : 'outline'}
        size="xs"
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setOpen(true);
        }}
      >
        {action.label}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)} title={action.label}>
        <div className="flex flex-col gap-4 px-5 py-4 text-[13px]">
          <p>{fillText(action.confirm, row)}</p>
          {error !== null && (
            <p role="alert" className="tint-bad rounded-md border px-3 py-2">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="chip" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={action.destructive ? 'danger' : 'brand'}
              size="chip"
              disabled={busy}
              onClick={() => void run()}
            >
              {busy ? 'Working…' : 'Confirm'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
