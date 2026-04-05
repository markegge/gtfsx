export const ROUTE_TYPES: Record<number, string> = {
  0: 'Tram / Light Rail',
  1: 'Subway / Metro',
  2: 'Rail',
  3: 'Bus',
  4: 'Ferry',
  5: 'Cable Tram',
  6: 'Aerial Lift',
  7: 'Funicular',
  11: 'Trolleybus',
  12: 'Monorail',
};

export const WHEELCHAIR_BOARDING: Record<number, string> = {
  0: 'Unknown',
  1: 'Accessible',
  2: 'Not Accessible',
};

export const LOCATION_TYPES: Record<number, string> = {
  0: 'Stop',
  1: 'Station',
  2: 'Entrance/Exit',
  3: 'Generic Node',
  4: 'Boarding Area',
};

import type { Route } from '../types/gtfs';

export function directionName(route: Route | undefined | null, directionId: 0 | 1): string {
  if (!route) return directionId === 0 ? 'Outbound' : 'Inbound';
  const name = directionId === 0 ? route._direction_0_name : route._direction_1_name;
  return name || (directionId === 0 ? 'Outbound' : 'Inbound');
}

export const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];
