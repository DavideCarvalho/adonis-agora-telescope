import { useState } from 'react';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { formatRelative } from '../client/format.js';
import type { CpuProfileContent, EntrySummary, HotFrame } from '../client/types.js';
import { Flamegraph } from './Flamegraph.js';
import { formatProfileMs } from './flamegraph.js';
import { Input } from './primitives/input.js';
import { AsyncBlock, Empty, PageHeader, Panel, SectionTitle, Skeleton } from './ui.js';
import {
  useArmProfile,
  useMeta,
  useProfile,
  useProfilerStatus,
  useProfiles,
} from './use-telescope.js';

/** Sidebar row for one captured profile. */
function ProfileRow({
  profile,
  selected,
  onSelect,
}: {
  profile: EntrySummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full flex-col gap-1 border-b border-line-soft border-l-2 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-hover ${
        selected ? 'border-l-brand bg-brand-soft' : 'border-l-transparent'
      }`}
    >
      <span className="mono truncate text-[12px] text-fg" title={profile.familyHash ?? profile.id}>
        {profile.familyHash ?? '(unlabelled)'}
      </span>
      <span className="mono flex items-center gap-2 text-[10.5px] text-faint">
        <span>{profile.durationMs !== null ? formatProfileMs(profile.durationMs) : '—'}</span>
        {profile.tags.includes('manual') && <Badge variant="warn">manual</Badge>}
        {profile.tags.includes('sampled') && <Badge variant="brand">sampled</Badge>}
        <span className="ml-auto">{formatRelative(profile.createdAt)}</span>
      </span>
    </button>
  );
}

/** "Hot functions" table (by self time), mirroring Sentry/Clinic profile views. */
function HotFunctions({ hot }: { hot: HotFrame[] }) {
  if (hot.length === 0) return <Empty>No hot frames.</Empty>;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        <span className="flex-1">Function</span>
        <span className="w-16 text-right">Self</span>
        <span className="w-12 text-right">%</span>
      </div>
      {hot.map((frame) => (
        <div
          key={`${frame.name}:${frame.file}`}
          className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5 text-[11.5px] last:border-0 hover:bg-hover"
        >
          <span
            className="mono min-w-0 flex-1 truncate text-fg"
            title={`${frame.name} ${frame.file}`}
          >
            {frame.name}
            {frame.file && <span className="ml-1 text-faint">{frame.file}</span>}
          </span>
          <span className="mono tnum w-16 text-right text-fg-2">
            {formatProfileMs(frame.selfMs)}
          </span>
          <span className="mono tnum w-12 text-right text-warn">{frame.selfPct.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

/** The flamegraph + hot-functions detail for one selected profile. */
function ProfileDetail({ id }: { id: string }) {
  const { data, loading } = useProfile(id);
  if (loading && !data) return <Skeleton rows={6} />;
  if (!data) return <Empty>Profile not found.</Empty>;
  const content = data.content as CpuProfileContent;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="mono text-[13px] font-medium text-fg">{content.label ?? '(unlabelled)'}</h3>
        <span className="mono text-[11px] text-faint">
          {formatProfileMs(content.durationMs)} · {content.sampleCount} samples · {content.reason}
        </span>
      </div>
      <Flamegraph tree={content.tree} />
      <HotFunctions hot={content.hot} />
    </div>
  );
}

/** A small control to arm an on-demand capture of the next N requests. */
function ArmControl({ pendingManual }: { pendingManual: number }) {
  const [count, setCount] = useState(1);
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [arming, setArming] = useState(false);
  const arm = useArmProfile();

  const submit = async () => {
    setArming(true);
    const outcome = await arm(count, label || undefined);
    setArming(false);
    setMessage(
      outcome.ok
        ? { ok: true, text: `${outcome.pendingManual} pending` }
        : { ok: false, text: outcome.message },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        Capture next
      </span>
      <Input
        type="number"
        min={1}
        value={count}
        onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
        aria-label="number of requests to capture"
        className="mono w-16"
      />
      <span className="text-[11px] text-dim">request(s) matching</span>
      <Input
        type="text"
        placeholder="any route (e.g. GET /users/:id)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        aria-label="route to capture"
        className="mono w-full sm:w-56"
      />
      <Button size="sm" variant="brand" disabled={arming} onClick={submit}>
        {arming ? 'Arming…' : 'Arm capture'}
      </Button>
      {pendingManual > 0 && <Badge variant="warn">{pendingManual} pending</Badge>}
      {message && (
        <span className={message.ok ? 'text-[11px] text-good' : 'text-[11px] text-bad'}>
          {message.text}
        </span>
      )}
    </div>
  );
}

/**
 * CPU profiling: capture + inspect real V8 flamegraphs. Ported from `nestjs-telescope`'s
 * `ProfilesPage` — the sidebar/flamegraph/hot-functions/arm-control layout is unchanged (the
 * underlying `node:inspector` capture is genuinely framework-agnostic, see the core package's
 * `src/profiling/*`); only the data source (`GET <path>/api/profiles*`) and styling primitives
 * are AdonisJS-specific.
 */
export function ProfilesSection() {
  const meta = useMeta();
  const status = useProfilerStatus();
  const { data: profiles, loading, error, reload } = useProfiles(100);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const enabled = meta.data?.profiling?.enabled ?? false;
  const list = profiles ?? [];
  const activeId = selectedId ?? list[0]?.id ?? null;

  const header = (
    <PageHeader
      title="Profiles"
      description="Real V8 CPU profiles of sampled or armed requests: flamegraph and hot functions."
    />
  );

  if (!enabled) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Panel>
          <SectionTitle title="CPU Profiles" />
          <Empty>
            CPU profiling is not installed for this dashboard. Enable it with the{' '}
            <code className="mono rounded-sm bg-panel-2 px-1 text-brand">
              @adonis-agora/telescope/cpu_profiling
            </code>{' '}
            provider. It is opt-in because it carries real CPU overhead; when off there is zero cost
            on the request path.
          </Empty>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {header}
      <Panel>
        <SectionTitle
          title="CPU Profiles"
          hint={
            status.data && (
              <span>
                sampling {(status.data.sampleRate * 100).toFixed(0)}% · {status.data.active} active
              </span>
            )
          }
        />
        <div className="mb-4">
          <ArmControl pendingManual={status.data?.pendingManual ?? 0} />
        </div>
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="max-h-[70vh] w-full shrink-0 overflow-y-auto rounded-lg border border-border lg:w-64">
            <AsyncBlock
              state={{ data: profiles, loading, error, reload }}
              isEmpty={(rows) => rows.length === 0}
              empty="No profiles captured yet."
            >
              {(rows) =>
                rows.map((profile) => (
                  <ProfileRow
                    key={profile.id}
                    profile={profile}
                    selected={profile.id === activeId}
                    onSelect={() => setSelectedId(profile.id)}
                  />
                ))
              }
            </AsyncBlock>
          </div>
          <div className="min-w-0 flex-1">
            {activeId ? (
              <ProfileDetail id={activeId} />
            ) : (
              <Empty>Select a profile to view its flamegraph.</Empty>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
