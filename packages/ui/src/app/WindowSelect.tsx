/** A small trailing-window picker (5m … 7d) shared by the Pulse and Exceptions views. */
const WINDOWS: { label: string; ms: number }[] = [
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 21_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 604_800_000 },
];

export function WindowSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (ms: number) => void;
}) {
  return (
    <select
      className="select"
      aria-label="time window"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {WINDOWS.map((w) => (
        <option key={w.ms} value={w.ms}>
          {w.label}
        </option>
      ))}
    </select>
  );
}
