import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../store';

function toCSV(data: Record<string, any>[]): string {
  if (data.length === 0) return '';
  return Papa.unparse(data);
}

function stripUIFields(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith('_') && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export async function exportGtfsZip(): Promise<Blob> {
  const state = useStore.getState();
  const zip = new JSZip();

  // agency.txt
  if (state.agencies.length > 0) {
    zip.file('agency.txt', toCSV(state.agencies.map(stripUIFields)));
  }

  // calendar.txt
  if (state.calendars.length > 0) {
    zip.file('calendar.txt', toCSV(state.calendars.map(stripUIFields)));
  }

  // calendar_dates.txt
  if (state.calendarDates.length > 0) {
    zip.file('calendar_dates.txt', toCSV(state.calendarDates.map(stripUIFields)));
  }

  // routes.txt
  if (state.routes.length > 0) {
    zip.file('routes.txt', toCSV(state.routes.map(stripUIFields)));
  }

  // stops.txt
  if (state.stops.length > 0) {
    zip.file('stops.txt', toCSV(state.stops.map(stripUIFields)));
  }

  // trips.txt
  if (state.trips.length > 0) {
    zip.file('trips.txt', toCSV(state.trips.map(stripUIFields)));
  }

  // stop_times.txt
  if (state.stopTimes.length > 0) {
    zip.file('stop_times.txt', toCSV(state.stopTimes.map(stripUIFields)));
  }

  // shapes.txt
  if (state.shapes.length > 0) {
    const shapeRows: Record<string, any>[] = [];
    for (const shape of state.shapes) {
      for (const pt of shape.points) {
        shapeRows.push({
          shape_id: shape.shape_id,
          shape_pt_lat: pt.shape_pt_lat,
          shape_pt_lon: pt.shape_pt_lon,
          shape_pt_sequence: pt.shape_pt_sequence,
          shape_dist_traveled: pt.shape_dist_traveled,
        });
      }
    }
    zip.file('shapes.txt', toCSV(shapeRows));
  }

  // fare_attributes.txt
  if (state.fareAttributes.length > 0) {
    zip.file('fare_attributes.txt', toCSV(state.fareAttributes.map(stripUIFields)));
  }

  // fare_rules.txt
  if (state.fareRules.length > 0) {
    zip.file('fare_rules.txt', toCSV(state.fareRules.map(stripUIFields)));
  }

  // feed_info.txt
  if (state.feedInfo) {
    zip.file('feed_info.txt', toCSV([stripUIFields(state.feedInfo)]));
  }

  return await zip.generateAsync({ type: 'blob' });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
