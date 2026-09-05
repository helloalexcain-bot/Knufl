import { createDefaultData, type KnuflData } from './types.ts';
import { reconcileMilestones } from './progression.ts';

export const STORAGE_KEY = 'knufl.progress.v1';

type PersistedData = Omit<Partial<KnuflData>, 'profile'> & {
  profile?: Record<string, unknown>;
};

const normalizeProgress = (parsed: PersistedData): KnuflData => {
  const defaults = createDefaultData();
  const savedName = typeof parsed.profile?.name === 'string' ? parsed.profile.name.trim() : '';
  return reconcileMilestones({
    version: 1,
    onboarded: Boolean(parsed.onboarded),
    profile: { name: savedName || defaults.profile.name },
    plan: { ...defaults.plan, ...(parsed.plan ?? {}) },
    logs: Array.isArray(parsed.logs) ? parsed.logs : [],
    memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    unlockedMoves: Array.isArray(parsed.unlockedMoves) ? parsed.unlockedMoves : [],
    restDates: Array.isArray(parsed.restDates) ? parsed.restDates : [],
    activeSession: parsed.activeSession,
    lastOpened: typeof parsed.lastOpened === 'string' ? parsed.lastOpened : '',
    dialogueCursor: typeof parsed.dialogueCursor === 'number' ? parsed.dialogueCursor : 0,
  });
};

export const readProgress = (): KnuflData => {
  if (typeof window === 'undefined') return createDefaultData();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultData();
    const parsed = JSON.parse(raw) as PersistedData;
    if (parsed.version !== 1) return createDefaultData();
    return normalizeProgress(parsed);
  } catch {
    return createDefaultData();
  }
};

export const writeProgress = (data: KnuflData): void => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }
};

export const parseProgressImport = (value: string): KnuflData => {
  const parsed = JSON.parse(value) as PersistedData;
  if (parsed.version !== 1 || !parsed.profile || !parsed.plan || !Array.isArray(parsed.logs)) {
    throw new Error('This file is not a valid Knufl progress export.');
  }
  return normalizeProgress(parsed);
};
