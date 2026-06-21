import type { StateCreator } from 'zustand';
import type { ValidationMessage } from '../types/ui';

export interface ValidationSlice {
  validationMessages: ValidationMessage[];
  isValidating: boolean;
  /**
   * Rule codes (see VALIDATION_CODES in services/validation.ts) the user has
   * dismissed for THIS feed. The validation panel hides any message whose
   * `code` is in this set (and offers a "restore" affordance). Persisted with
   * the feed's working snapshot (IndexedDB + server R2), scoped per feed — a
   * different feed still shows the rule. Stored as a string[] (not a Set) so it
   * round-trips through JSON/structured-clone persistence, mirroring
   * featureSettings.
   */
  dismissedValidations: string[];
  setValidationMessages: (messages: ValidationMessage[]) => void;
  clearValidationMessages: () => void;
  setIsValidating: (v: boolean) => void;
  /** Silence a validation rule for this feed (no-op if already dismissed). */
  dismissValidation: (code: string) => void;
  /** Un-dismiss a previously silenced rule for this feed. */
  restoreValidation: (code: string) => void;
  /** Replace the whole dismissed set (used by the persistence load paths). */
  setDismissedValidations: (codes: string[]) => void;
}

export const createValidationSlice: StateCreator<ValidationSlice, [['zustand/immer', never]], [], ValidationSlice> = (set) => ({
  validationMessages: [],
  isValidating: false,
  dismissedValidations: [],
  setValidationMessages: (messages) => set((state) => { state.validationMessages = messages; }),
  clearValidationMessages: () => set((state) => { state.validationMessages = []; }),
  setIsValidating: (v) => set((state) => { state.isValidating = v; }),
  dismissValidation: (code) => set((state) => {
    if (!state.dismissedValidations.includes(code)) state.dismissedValidations.push(code);
  }),
  restoreValidation: (code) => set((state) => {
    state.dismissedValidations = state.dismissedValidations.filter((c) => c !== code);
  }),
  // De-dup on set so a malformed snapshot can't seed duplicates.
  setDismissedValidations: (codes) => set((state) => {
    state.dismissedValidations = Array.from(new Set(Array.isArray(codes) ? codes : []));
  }),
});
