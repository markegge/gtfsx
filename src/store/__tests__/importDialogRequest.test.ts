// Cross-component request flag that lets panels (e.g. the Routes panel's
// "Import from another feed" button) open the top-bar Import dialog seeded to
// a specific source tab. See importDialogSource in src/store/uiSlice.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';

function reset() {
  useStore.getState().clearImportDialogRequest();
}
beforeEach(reset);
afterEach(reset);

describe('import dialog request flag', () => {
  it('defaults to null (no request pending)', () => {
    expect(useStore.getState().importDialogSource).toBeNull();
  });

  it('requestImportDialog seeds the source tab', () => {
    useStore.getState().requestImportDialog('myfeeds');
    expect(useStore.getState().importDialogSource).toBe('myfeeds');

    useStore.getState().requestImportDialog('upload');
    expect(useStore.getState().importDialogSource).toBe('upload');
  });

  it('clearImportDialogRequest resets the flag (consumed on dialog close)', () => {
    useStore.getState().requestImportDialog('myfeeds');
    useStore.getState().clearImportDialogRequest();
    expect(useStore.getState().importDialogSource).toBeNull();
  });
});
