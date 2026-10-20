import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UserState {
  token: string | null;
  username: string | null;
  role: 'user' | 'admin' | null;
  login: (token: string, username: string, role: 'user' | 'admin') => void;
  logout: () => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      token: null,
      username: null,
      role: null,
      login: (token, username, role) => set({ token, username, role }),
      logout: () => set({ token: null, username: null, role: null }),
    }),
    { name: 'invest-user' },
  ),
);
