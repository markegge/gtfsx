import type { StateCreator } from 'zustand';
import type { Transfer } from '../types/gtfs';

export interface TransferSlice {
  transfers: Transfer[];
  addTransfer: (transfer: Transfer) => void;
  updateTransfer: (index: number, updates: Partial<Transfer>) => void;
  removeTransfer: (index: number) => void;
  setTransfers: (transfers: Transfer[]) => void;
}

export const createTransferSlice: StateCreator<TransferSlice, [['zustand/immer', never]], [], TransferSlice> = (set) => ({
  transfers: [],
  addTransfer: (transfer) => set((state) => { state.transfers.push(transfer); }),
  updateTransfer: (index, updates) => set((state) => {
    if (index >= 0 && index < state.transfers.length) {
      Object.assign(state.transfers[index], updates);
    }
  }),
  removeTransfer: (index) => set((state) => {
    if (index >= 0 && index < state.transfers.length) {
      state.transfers.splice(index, 1);
    }
  }),
  setTransfers: (transfers) => set((state) => { state.transfers = transfers; }),
});
