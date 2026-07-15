// The Flex Zones detail sub-panel is store-backed (flexZoneDetailId) so it
// survives the rail unmounting during flex shape editing. Distinct from
// editingFlexZoneId, which is the map's shape-edit target.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';

function reset() {
  useStore.getState().setFlexZoneDetailId(null);
  useStore.getState().setEditingFlexZoneId(null);
  useStore.getState().setSidebarSection(null);
}
beforeEach(reset);
afterEach(reset);

describe('flexZoneDetailId (flex detail sub-panel)', () => {
  it('defaults to null (list view)', () => {
    expect(useStore.getState().flexZoneDetailId).toBeNull();
  });

  it('opens and closes the detail sub-panel', () => {
    useStore.getState().setFlexZoneDetailId('flex-zone-1');
    expect(useStore.getState().flexZoneDetailId).toBe('flex-zone-1');

    useStore.getState().setFlexZoneDetailId(null);
    expect(useStore.getState().flexZoneDetailId).toBeNull();
  });

  it('is independent of editingFlexZoneId (the shape-edit target)', () => {
    useStore.getState().setSidebarSection('flex');
    useStore.getState().setFlexZoneDetailId('flex-zone-1');
    useStore.getState().setEditingFlexZoneId('flex-zone-1');

    // Finishing a shape edit clears the map target but keeps the open panel.
    useStore.getState().setEditingFlexZoneId(null);
    expect(useStore.getState().flexZoneDetailId).toBe('flex-zone-1');
  });

  it('survives a section re-select of flex', () => {
    useStore.getState().setSidebarSection('flex');
    useStore.getState().setFlexZoneDetailId('flex-zone-1');
    useStore.getState().setSidebarSection('flex');
    expect(useStore.getState().flexZoneDetailId).toBe('flex-zone-1');
  });

  it('setSidebarSection away from flex clears it', () => {
    useStore.getState().setSidebarSection('flex');
    useStore.getState().setFlexZoneDetailId('flex-zone-1');

    useStore.getState().setSidebarSection('routes');
    expect(useStore.getState().flexZoneDetailId).toBeNull();
  });

  it('closing the rail entirely clears it', () => {
    useStore.getState().setSidebarSection('flex');
    useStore.getState().setFlexZoneDetailId('flex-zone-1');

    useStore.getState().setSidebarSection(null);
    expect(useStore.getState().flexZoneDetailId).toBeNull();
  });
});
