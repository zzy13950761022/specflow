import { createContext, useContext } from 'react';
import type { RepoEntry, SpecFile } from '../types';

export interface AppState {
  repos: RepoEntry[];
  activeRepo: string | null;
  specs: SpecFile[];
  error: string | null;
  setActiveRepo: (id: string) => void;
  refreshSpecs: (repoId: string) => Promise<void>;
  setError: (e: string | null) => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppContext provider');
  return ctx;
}
