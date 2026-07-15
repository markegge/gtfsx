import type { Plan } from '../../services/billingApi';
import { planDisplayName } from './planConfig';

const STYLES: Record<Plan, string> = {
  free: 'bg-sand text-brown',
  agency: 'bg-purple-light text-purple',
  enterprise: 'bg-gold-light text-amber-700',
};

export function PlanBadge({ plan, size = 'sm' }: { plan: Plan; size?: 'sm' | 'md' }) {
  const cls = STYLES[plan];
  const sizeCls = size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[10px]';
  return (
    <span className={`inline-flex items-center rounded-full ${sizeCls} font-bold uppercase tracking-wide ${cls}`}>
      {planDisplayName(plan)}
    </span>
  );
}
