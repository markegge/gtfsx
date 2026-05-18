import type { StateCreator } from 'zustand';
import { me as fetchMe, type AuthedUser } from '../services/authApi';
import type { OrgsSlice } from './orgsSlice';

export interface AuthSlice {
  currentUser: AuthedUser | null;
  authLoading: boolean;
  authChecked: boolean;
  hydrateAuth: () => Promise<void>;
  setCurrentUser: (user: AuthedUser | null) => void;
  clearAuth: () => void;
}

// AuthSlice reaches across to OrgsSlice to kick off loadOrgs on login and
// clearOrgs on logout. Widening the StateCreator over the union keeps the
// types honest without introducing a circular import at runtime (orgsSlice
// doesn't import anything from authSlice).
export const createAuthSlice: StateCreator<
  AuthSlice & OrgsSlice,
  [['zustand/immer', never]],
  [],
  AuthSlice
> = (set, get) => ({
  currentUser: null,
  authLoading: false,
  authChecked: false,

  hydrateAuth: async () => {
    if (get().authLoading) return;
    set((state) => {
      state.authLoading = true;
    });
    try {
      const { user } = await fetchMe();
      set((state) => {
        state.currentUser = user;
        state.authLoading = false;
        state.authChecked = true;
      });
      // Fetch the user's org memberships so the workspace switcher is
      // populated before the user opens it.
      get().loadOrgs().catch(() => {});
    } catch {
      set((state) => {
        state.currentUser = null;
        state.authLoading = false;
        state.authChecked = true;
      });
    }
  },

  setCurrentUser: (user) => {
    // Login / signup / magic-link consume / verify-email all funnel through
    // setCurrentUser without going through hydrateAuth, so without this
    // refresh the workspace switcher would keep showing the anonymous
    // session's (empty) org list until the user navigated to a page that
    // explicitly calls loadOrgs. Re-fetch whenever the signed-in user id
    // changes (including null → set).
    const prevId = get().currentUser?.id ?? null;
    set((state) => {
      state.currentUser = user;
      state.authChecked = true;
    });
    if (user && user.id !== prevId) {
      get().loadOrgs().catch(() => {});
    }
  },

  clearAuth: () => {
    set((state) => {
      state.currentUser = null;
      state.authChecked = true;
    });
    get().clearOrgs();
  },
});
