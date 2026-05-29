import { useEffect, useState } from 'react';
import { AdminLayout } from './AdminLayout';
import { AuthButton } from '../auth/AuthButton';
import { getAdminStats, type AdminStats } from '../../services/adminApi';
import { ApiError } from '../../services/authApi';

function fmt(n: number): string {
  return new Intl.NumberFormat().format(n);
}

interface CounterCardProps {
  label: string;
  value: number;
  sub?: { label: string; value: number }[];
  accent?: 'coral' | 'teal' | 'gold' | 'purple';
}

const ACCENT_BG: Record<NonNullable<CounterCardProps['accent']>, string> = {
  coral: 'from-coral-light to-white',
  teal: 'from-teal-light to-white',
  gold: 'from-gold-light to-white',
  purple: 'from-purple-light to-white',
};

function CounterCard({ label, value, sub, accent = 'coral' }: CounterCardProps) {
  return (
    <div
      className={`bg-gradient-to-br ${ACCENT_BG[accent]} border border-sand rounded-2xl p-5 shadow-sm`}
    >
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
        {label}
      </div>
      <div className="font-heading font-extrabold text-4xl text-dark-brown leading-none mb-3">
        {fmt(value)}
      </div>
      {sub && sub.length > 0 && (
        <div className="text-xs text-warm-gray space-y-0.5">
          {sub.map((s) => (
            <div key={s.label} className="flex justify-between gap-3">
              <span>{s.label}</span>
              <span className="font-semibold text-dark-brown">{fmt(s.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BucketCard({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: number }[];
}) {
  return (
    <div className="bg-white border border-sand rounded-2xl p-5 shadow-sm">
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-3">
        {title}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {items.map((i) => (
          <div key={i.label}>
            <div className="font-heading font-extrabold text-2xl text-dark-brown leading-none">
              {fmt(i.value)}
            </div>
            <div className="text-xs text-warm-gray mt-1">{i.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WeekSparkline({
  title,
  data,
}: {
  title: string;
  data: { week: string; count: number }[];
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="bg-white border border-sand rounded-2xl p-5 shadow-sm">
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-3">
        {title}
      </div>
      <div className="flex items-end gap-2 h-24">
        {data.map((d) => {
          const h = (d.count / max) * 100;
          return (
            <div
              key={d.week}
              className="flex-1 flex flex-col items-center justify-end gap-1"
              title={`${d.week}: ${d.count}`}
            >
              <div
                className="w-full bg-coral rounded-t-sm"
                style={{ height: `${Math.max(2, h)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-2 mt-2">
        {data.map((d) => (
          <div
            key={d.week}
            className="flex-1 text-center text-[10px] text-warm-gray font-mono"
          >
            {d.week.slice(-2)}
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-1">
        {data.map((d) => (
          <div
            key={d.week}
            className="flex-1 text-center text-[11px] font-semibold text-dark-brown"
          >
            {fmt(d.count)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getAdminStats();
      setStats(s);
      setRefreshedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <AdminLayout
      title="Dashboard"
      subtitle={
        refreshedAt
          ? `Last refreshed ${new Date(refreshedAt).toLocaleTimeString()}. Stats cache at 60s TTL.`
          : 'Live counters for users, organizations, projects, and publications.'
      }
      headerExtra={
        <AuthButton onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </AuthButton>
      }
    >
      {error && (
        <div className="mb-5 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {!stats && loading && (
        <div className="text-warm-gray text-sm">Loading stats…</div>
      )}

      {stats && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <CounterCard
              label="Total users"
              value={stats.users.total}
              accent="coral"
              sub={[
                { label: 'Active', value: stats.users.active },
                { label: 'Pending verification', value: stats.users.pending_verification },
                { label: 'Disabled', value: stats.users.disabled },
                { label: 'Deleted (soft)', value: stats.users.deleted_soft },
              ]}
            />
            <CounterCard
              label="Organizations"
              value={stats.organizations.total}
              accent="teal"
            />
            <CounterCard
              label="Projects"
              value={stats.projects.total}
              accent="gold"
              sub={[
                { label: 'User-owned', value: stats.projects.byOwnerType.user },
                { label: 'Org-owned', value: stats.projects.byOwnerType.org },
              ]}
            />
            <CounterCard
              label="Publications"
              value={stats.publications.total}
              accent="purple"
              sub={[{ label: 'Feed snapshots', value: stats.snapshots.total }]}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <BucketCard
              title="Signups"
              items={[
                { label: 'Last 7 days', value: stats.signups.last7d },
                { label: 'Last 30 days', value: stats.signups.last30d },
                { label: 'All time', value: stats.signups.allTime },
              ]}
            />
            <BucketCard
              title="Active users (sessions used)"
              items={[
                { label: 'Last 24h', value: stats.activeUsers.last24h },
                { label: 'Last 7 days', value: stats.activeUsers.last7d },
                { label: 'Last 30 days', value: stats.activeUsers.last30d },
              ]}
            />
            <BucketCard
              title="Users by plan"
              items={[
                { label: 'Free', value: stats.usersByPlan?.free ?? 0 },
                { label: 'Pro', value: stats.usersByPlan?.pro ?? 0 },
                { label: 'Agency', value: stats.usersByPlan?.team ?? 0 },
                { label: 'Enterprise', value: stats.usersByPlan?.enterprise ?? 0 },
              ]}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <WeekSparkline
              title="New users — trailing 8 weeks"
              data={stats.trend.newUsersByWeek}
            />
            <WeekSparkline
              title="New projects — trailing 8 weeks"
              data={stats.trend.newProjectsByWeek}
            />
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
