interface UsageMeterProps {
  label: string;
  used: number;
  limit: number;
  unit?: string;
  /** Treat `limit` as effectively unbounded — render "Unlimited" instead of a bar. */
  unbounded?: boolean;
}

export function UsageMeter({ label, used, limit, unit, unbounded }: UsageMeterProps) {
  if (unbounded || limit >= 9999) {
    return (
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-warm-gray">{label}</span>
        <span className="font-semibold text-brown">{used.toLocaleString()}{unit ? ` ${unit}` : ''} <span className="text-warm-gray font-normal">/ Unlimited</span></span>
      </div>
    );
  }
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const overBudget = used > limit;
  const warning = pct >= 90;
  const barCls = overBudget
    ? 'bg-red-500'
    : warning
      ? 'bg-coral'
      : 'bg-teal';
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-warm-gray">{label}</span>
        <span className={`font-semibold ${overBudget ? 'text-red-600' : 'text-brown'}`}>
          {used.toLocaleString()}{unit ? ` ${unit}` : ''} <span className="text-warm-gray font-normal">/ {limit.toLocaleString()}{unit ? ` ${unit}` : ''}</span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-sand">
        <div className={`h-full rounded-full transition-all ${barCls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
