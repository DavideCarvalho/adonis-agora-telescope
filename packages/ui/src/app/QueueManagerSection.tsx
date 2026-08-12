import { useState } from 'react';
import { formatCount } from '../client/format.js';
import type { QueueJobDetail, QueueSummary } from '../client/types.js';
import { Badge } from './primitives/badge.js';
import { Button } from './primitives/button.js';
import { Input } from './primitives/input.js';
import { AsyncBlock, Empty, Panel, SectionTitle, clickable } from './ui.js';
import { useLiveQueues, useMeta, useTelescopeClient } from './use-telescope.js';

function QueueCounts({ queue }: { queue: QueueSummary }) {
  const { counts } = queue;
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
      <span>
        pending <b className="tnum text-foreground">{formatCount(counts.pending)}</b>
      </span>
      <span title="This driver cannot report this count — see the docs for what @boringnode/queue's public API actually exposes.">
        active <b className="tnum">{counts.active === null ? '—' : formatCount(counts.active)}</b>
      </span>
      <span title="This driver cannot report this count.">
        delayed{' '}
        <b className="tnum">{counts.delayed === null ? '—' : formatCount(counts.delayed)}</b>
      </span>
      <span title="This driver cannot report this count.">
        failed <b className="tnum">{counts.failed === null ? '—' : formatCount(counts.failed)}</b>
      </span>
      <span title="This driver cannot report this count.">
        completed{' '}
        <b className="tnum">{counts.completed === null ? '—' : formatCount(counts.completed)}</b>
      </span>
    </div>
  );
}

function JobDetail({
  job,
  canRetry,
  onRetry,
  retrying,
  retryMessage,
}: {
  job: QueueJobDetail;
  canRetry: boolean;
  onRetry: () => void;
  retrying: boolean;
  retryMessage: string | null;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-line bg-panel/40 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="mono text-foreground">{job.name ?? '(unnamed)'}</div>
          <div className="text-[10px] text-muted-foreground">id: {job.id}</div>
        </div>
        <div className="flex items-center gap-2">
          {job.state && (
            <Badge variant={job.state === 'failed' ? 'bad' : 'outline'}>{job.state}</Badge>
          )}
          {canRetry && (
            <Button variant="brand" disabled={retrying} onClick={onRetry}>
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          )}
        </div>
      </div>
      {job.failedReason && (
        <div className="rounded border border-bad/30 bg-bad/10 p-2 text-bad">
          {job.failedReason}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
        <span>
          attempts: {job.attemptsMade ?? '—'} / {job.maxAttempts ?? '—'}
        </span>
        <span>created: {job.createdAt ?? '—'}</span>
        <span>processed: {job.processedAt ?? '—'}</span>
        <span>finished: {job.finishedAt ?? '—'}</span>
      </div>
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Payload
        </div>
        <pre className="mono max-h-40 overflow-auto rounded bg-background p-2 text-[10px]">
          {JSON.stringify(job.payload, null, 2)}
        </pre>
      </div>
      {retryMessage && <p className="text-bad">{retryMessage}</p>}
    </div>
  );
}

function EnqueueForm({ queue }: { queue: string }) {
  const client = useTelescopeClient();
  const [name, setName] = useState('');
  const [payload, setPayload] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setMessage({ ok: false, text: 'Payload must be valid JSON.' });
      return;
    }
    setBusy(true);
    const outcome = await client.enqueueJob(queue, parsed, name || undefined);
    setBusy(false);
    setMessage(
      outcome.ok
        ? { ok: true, text: `Enqueued${outcome.id ? ` as ${outcome.id}` : ''}.` }
        : { ok: false, text: outcome.message },
    );
  };

  return (
    <div className="space-y-2 rounded-lg border border-line bg-panel/40 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Enqueue a job on "{queue}"
      </div>
      <Input
        placeholder="job name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        rows={4}
        className="mono w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder="{}"
      />
      <div className="flex items-center gap-2">
        <Button variant="brand" disabled={busy} onClick={submit}>
          {busy ? 'Enqueuing…' : 'Enqueue'}
        </Button>
        {message && (
          <span className={message.ok ? 'text-[11px] text-good' : 'text-[11px] text-bad'}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Live Queue Manager: list/inspect/retry/enqueue over `@adonisjs/queue` (powered by
 * `@boringnode/queue`). Deliberately a SMALLER console than the NestJS sibling's BullMQ-backed
 * queue manager — `@boringnode/queue`'s public API has no per-state job listing, no remove, and no
 * promote (confirmed against the published `Adapter` interface; see the core package's
 * `src/watchers/queue_manager.ts` for the full research trail). What IS here — a pending count,
 * single-job lookup by id, retry-by-id, and enqueue — is genuinely supported, not faked.
 */
export function QueueManagerSection() {
  const meta = useMeta();
  const { data, loading, error } = useLiveQueues();
  const client = useTelescopeClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [jobIdInput, setJobIdInput] = useState('');
  const [job, setJob] = useState<QueueJobDetail | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  const enabled = meta.data?.queueManager?.enabled ?? false;

  if (!enabled) {
    return (
      <Panel>
        <SectionTitle title="Queue Manager" />
        <Empty>
          The live queue manager is not configured. Enable the{' '}
          <code className="mono rounded bg-panel-2 px-1 text-brand">queue-manager</code> watcher and
          set{' '}
          <code className="mono rounded bg-panel-2 px-1 text-brand">
            telescope_watchers.queueManager.queues
          </code>{' '}
          to the queue names you want surfaced — <code className="mono">@boringnode/queue</code> has
          no queue-enumeration API, so there is nothing to auto-discover.
        </Empty>
      </Panel>
    );
  }

  const queues = data?.queues ?? [];
  const capabilities = data?.capabilities;
  const selectedSummary = queues.find((q) => q.queue === selected);
  const canRetry = capabilities?.mutationsEnabled && capabilities.actions.includes('retry');
  const canEnqueue = capabilities?.mutationsEnabled && capabilities.actions.includes('enqueue');

  const lookupJob = async () => {
    if (!selected || !jobIdInput) return;
    setJobError(null);
    setRetryMessage(null);
    const found = await client.queueJob(selected, jobIdInput);
    if (found === null) {
      setJob(null);
      setJobError('No job with that id.');
    } else {
      setJob(found);
    }
  };

  const retry = async () => {
    if (!selected || !job) return;
    setRetrying(true);
    const outcome = await client.retryJob(selected, job.id);
    setRetrying(false);
    setRetryMessage(outcome.ok ? null : outcome.message);
    if (outcome.ok) await lookupJob();
  };

  return (
    <Panel>
      <SectionTitle
        title="Queue Manager"
        hint={
          capabilities && !capabilities.mutationsEnabled
            ? 'read-only (set telescope_ui.queueActions.enabled to allow retry/enqueue)'
            : undefined
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="space-y-2">
          <AsyncBlock
            state={{ data: data ? queues : null, loading, error }}
            isEmpty={(rows) => rows.length === 0}
            empty="No queues configured."
          >
            {(rows) => (
              <div className="space-y-1.5">
                {rows.map((q) => (
                  <button
                    type="button"
                    key={q.queue}
                    {...clickable(() => {
                      setSelected(q.queue);
                      setJob(null);
                      setJobIdInput('');
                      setJobError(null);
                    })}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${
                      selected === q.queue
                        ? 'border-brand bg-brand/10'
                        : 'border-line hover:bg-panel'
                    }`}
                  >
                    <div className="mono text-foreground">{q.queue}</div>
                    <QueueCounts queue={q} />
                  </button>
                ))}
              </div>
            )}
          </AsyncBlock>
        </aside>

        <section className="min-w-0 space-y-3">
          {!selectedSummary ? (
            <div className="rounded-lg border border-dashed border-line px-4 py-12 text-center text-xs text-muted-foreground">
              Select a queue to look up or enqueue a job.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="job id"
                  value={jobIdInput}
                  onChange={(e) => setJobIdInput(e.target.value)}
                  className="max-w-xs"
                />
                <Button onClick={lookupJob}>Look up</Button>
              </div>
              {jobError && <p className="text-xs text-bad">{jobError}</p>}
              {job && (
                <JobDetail
                  job={job}
                  canRetry={Boolean(canRetry)}
                  onRetry={retry}
                  retrying={retrying}
                  retryMessage={retryMessage}
                />
              )}
              {canEnqueue && <EnqueueForm queue={selectedSummary.queue} />}
            </>
          )}
        </section>
      </div>
    </Panel>
  );
}
