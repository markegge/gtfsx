import Dexie, { type Table } from 'dexie';
import type { StopTime, Shape } from '../types/gtfs';

export interface ProjectRecord {
  id: string;
  name: string;
  lastModified: number;
}

export interface ProjectDataRecord {
  projectId: string;
  // Structured snapshot of all the *small* store tables. Stored as a plain
  // object (IndexedDB structured-clones it natively) — no JSON string. Legacy
  // v1 rows hold a JSON string with everything (incl. stopTimes/shapes) inline;
  // loadProject handles both shapes.
  storeSnapshot: unknown;
}

// The two tables that dominate feed size (millions of rows for a regional
// feed) live in their own record so routine edits — which touch routes, trips,
// or stop metadata, not stop_times — don't re-serialize the whole schedule on
// every autosave. Written only when stopTimes/shapes actually change.
export interface ProjectBulkRecord {
  projectId: string;
  stopTimes: StopTime[];
  shapes: Shape[];
}

export class GTFSDatabase extends Dexie {
  projects!: Table<ProjectRecord>;
  projectData!: Table<ProjectDataRecord>;
  projectBulk!: Table<ProjectBulkRecord>;

  constructor() {
    super('gtfs-builder');
    this.version(1).stores({
      projects: 'id',
      projectData: 'projectId',
    });
    // v2: split the heavy stop_times/shapes tables out of the snapshot blob.
    // The .stores() schema only declares keys/indexes, so existing v1 rows
    // (storeSnapshot as a JSON string) keep working — loadProject reads both.
    this.version(2).stores({
      projects: 'id',
      projectData: 'projectId',
      projectBulk: 'projectId',
    });
  }
}

export const db = new GTFSDatabase();
