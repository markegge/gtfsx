import type { StateCreator } from 'zustand';
import { me as fetchMe, type AuthedUser } from '../services/authApi';

export interface AuthSlice {
  currentUser: AuthedUser | null;
  authLoading: boolean;
  authChecked: boolean;
  hydrateAuth: () => Promise<void>;
  setCurrentUser: (user: AuthedUser | null) => void;
  clearAuth: () => void;
}

export const createAuthSlice: StateCreator<AuthSlice, [['zustand/immer', never]], [], AuthSlice> = (set, get) => ({
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
    } catch {
      set((state) => {
        state.currentUser = null;
        state.authLoading = false;
        state.authChecked = true;
      });
    }
  },

  setCurrentUser: (user) =>
    set((state) => {
      state.currentUser = user;
      state.authChecked = true;
    }),

  clearAuth: () =>
    set((state) => {
      state.currentUser = null;
      state.authChecked = true;
    }),
});
