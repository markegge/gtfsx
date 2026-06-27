// Drop-in replacement for `zustand/middleware/immer` that ALSO captures Immer
// inverse-patches for the undo/redo history (history.ts, GitHub #49).
//
// It presents the identical `['zustand/immer', never]` store mutator, so every
// slice typed against the stock immer middleware composes unchanged. The only
// behavioural difference: each recipe `set` runs through `produceWithPatches`
// (instead of `produce`) and the resulting patch sets are handed to
// `recordChange`. The recipe still runs EXACTLY ONCE — important, because some
// recipes are non-deterministic (e.g. routeSlice.duplicateRoute mints ids with
// `generateId` inside the recipe), so a re-run would desync the patches.
//
// Non-recipe `set(object, replace)` calls (the undo/redo patch-apply path, and
// any direct `setState(obj)`) pass straight through without patch capture.

// Keep the `['zustand/immer']` StoreMutators augmentation in the type program
// now that we no longer import the stock middleware at runtime.
import type {} from 'zustand/middleware/immer';
import { produce, produceWithPatches, enablePatches, type Draft } from 'immer';
import type { StateCreator, StoreMutatorIdentifier } from 'zustand';
import { recordChange, isSuppressed } from './history';

enablePatches();

type ImmerWithHistory = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  U = T,
>(
  initializer: StateCreator<T, [...Mps, ['zustand/immer', never]], Mcs, U>,
) => StateCreator<T, Mps, [['zustand/immer', never], ...Mcs], U>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const immerWithHistoryImpl =
  (initializer: any) =>
  (set: any, get: any, store: any) => {
    store.setState = (updater: any, replace?: any, ...args: any[]) => {
      // Plain-object / partial updates (incl. the undo/redo apply path) don't
      // carry a recipe — nothing to diff, pass through untouched.
      if (typeof updater !== 'function') {
        return set(updater, replace, ...args);
      }
      // During a suppressed bulk load (or undo/redo apply) skip the patch work
      // and behave exactly like the stock immer middleware.
      if (isSuppressed()) {
        return set(produce(updater as (d: Draft<unknown>) => void), replace, ...args);
      }
      // `get()` is `unknown` here, which trips up produceWithPatches' overload
      // inference (it resolves to the curried form); call through `any` — the
      // surrounding impl is already untyped zustand-mutator plumbing.
      const [nextState, patches, inversePatches] = (produceWithPatches as any)(
        get(),
        updater as (d: Draft<unknown>) => void,
      );
      recordChange(patches, inversePatches);
      return set(nextState, replace, ...args);
    };
    return initializer(store.setState, get, store);
  };
/* eslint-enable @typescript-eslint/no-explicit-any */

export const immerWithHistory = immerWithHistoryImpl as unknown as ImmerWithHistory;
