
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { EmptyState } from '../ui/EmptyState';
import { RailSubHeading, RailDivider } from '../ui/RailHeadings';
import { generateId } from '../../services/idGenerator';
import { US_TIMEZONES } from '../../utils/constants';

export function AgencyEditor() {
  const { agencies, addAgency, updateAgency, feedInfo, updateFeedInfo } = useStore();

  const handleAdd = () => {
    addAgency({
      agency_id: generateId('agency'),
      agency_name: '',
      agency_url: '',
      agency_timezone: 'America/Denver',
    });
  };

  if (agencies.length === 0) {
    return (
      <EmptyState
        icon="🏢"
        title="No agency defined"
        description="Add your transit agency to get started."
        actionLabel="Add Agency"
        onAction={handleAdd}
      />
    );
  }

  const agency = agencies[0];

  return (
    <div>
      <FormField
        label="Agency Name"
        value={agency.agency_name}
        onChange={(v) => updateAgency(agency.agency_id, { agency_name: v })}
        placeholder="e.g., Streamline Transit"
        required
      />
      <FormField
        label="Agency URL"
        value={agency.agency_url}
        onChange={(v) => updateAgency(agency.agency_id, { agency_url: v })}
        placeholder="https://..."
        required
      />
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Timezone <span className="text-coral">*</span>
        </label>
        <select
          value={agency.agency_timezone}
          onChange={(e) => updateAgency(agency.agency_id, { agency_timezone: e.target.value })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        >
          {US_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField
          label="Phone"
          value={agency.agency_phone || ''}
          onChange={(v) => updateAgency(agency.agency_id, { agency_phone: v })}
          placeholder="(555) 123-4567"
        />
        <FormField
          label="Email"
          value={agency.agency_email || ''}
          onChange={(v) => updateAgency(agency.agency_id, { agency_email: v })}
          placeholder="info@agency.com"
        />
      </div>
      <FormField
        label="Language"
        value={agency.agency_lang || 'en-US'}
        onChange={(v) => updateAgency(agency.agency_id, { agency_lang: v })}
      />

      <RailDivider />
      <RailSubHeading>Feed Info</RailSubHeading>
      {/* feed_publisher is fixed to GTFS·X on every export and publish (see
          gtfsExport buildFeedInfoRow). The prior/imported publisher is shown
          here read-only for reference but is never written to the exported
          feed_info.txt. */}
      <FormField
        label="Prior publisher"
        value={feedInfo?.feed_publisher_name || ''}
        onChange={() => {}}
        disabled
        placeholder="None — published as GTFS·X"
      />
      <FormField
        label="Prior publisher URL"
        value={feedInfo?.feed_publisher_url || ''}
        onChange={() => {}}
        disabled
        placeholder="None — published as GTFS·X"
      />
      <FormField
        label="Feed Language"
        value={feedInfo?.feed_lang || 'en-US'}
        onChange={(v) => updateFeedInfo({ feed_lang: v })}
      />
      <FormField
        label="Feed Version"
        value={feedInfo?.feed_version || ''}
        onChange={(v) => updateFeedInfo({ feed_version: v })}
        placeholder="e.g., 2026-03"
      />
    </div>
  );
}
