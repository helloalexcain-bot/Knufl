import type { KnuflData, Memory, MilestoneId, SessionLog } from './types';

export const localDateKey = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const creditedDays = (logs: SessionLog[]): string[] =>
  [...new Set(logs.map((log) => log.date))].sort();

export const practiceCredits = (logs: SessionLog[]): number => creditedDays(logs).length;

export const createId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export interface SaveResult {
  data: KnuflData;
  log: SessionLog;
  created: boolean;
  alreadyCreditedToday: boolean;
  unlockedNow: MilestoneId[];
}

export const addSession = (data: KnuflData, log: SessionLog): SaveResult => {
  const duplicate = data.logs.find((item) => item.submissionKey === log.submissionKey);
  if (duplicate) {
    return {
      data,
      log: duplicate,
      created: false,
      alreadyCreditedToday: data.logs.some((item) => item.date === duplicate.date && item.id !== duplicate.id),
      unlockedNow: [],
    };
  }

  const alreadyCreditedToday = data.logs.some((item) => item.date === log.date);
  const logs = [...data.logs, log];
  const nextCredits = practiceCredits(logs);
  const unlockedNow: MilestoneId[] = [];
  const unlockedMoves = [...data.unlockedMoves];

  if (!unlockedMoves.includes('first-session')) {
    unlockedMoves.push('first-session');
    unlockedNow.push('first-session');
  }
  if (nextCredits >= 3 && !unlockedMoves.includes('little-mountain')) {
    unlockedMoves.push('little-mountain');
    unlockedNow.push('little-mountain');
  }

  const memories = [...data.memories];
  if (data.logs.length === 0) {
    memories.push({
      id: createId(),
      associatedSessionId: log.id,
      title: 'Our first session',
      note: 'The day we began getting stronger together.',
      createdAt: log.createdAt,
    });
  }
  if (unlockedNow.includes('little-mountain')) {
    memories.push({
      id: createId(),
      associatedSessionId: log.id,
      title: 'Little Mountain',
      note: 'Three practice days. A steadier stance, and the same big heart.',
      createdAt: log.createdAt,
    });
  }

  return {
    data: { ...data, logs, memories, unlockedMoves },
    log,
    created: true,
    alreadyCreditedToday,
    unlockedNow,
  };
};

export const reconcileMilestones = (data: KnuflData, associatedSessionId?: string): KnuflData => {
  const unlockedMoves = [...data.unlockedMoves];
  const memories = [...data.memories];
  const logs = data.logs;
  if (logs.length > 0 && !unlockedMoves.includes('first-session')) unlockedMoves.push('first-session');
  if (practiceCredits(logs) >= 3 && !unlockedMoves.includes('little-mountain')) {
    unlockedMoves.push('little-mountain');
    const session = logs.find((log) => log.id === associatedSessionId) ?? logs[logs.length - 1];
    if (session) {
      memories.push({
        id: createId(),
        associatedSessionId: session.id,
        title: 'Little Mountain',
        note: 'Three practice days. A steadier stance, and the same big heart.',
        createdAt: new Date().toISOString(),
      });
    }
  }
  return { ...data, unlockedMoves, memories };
};

export const updateSession = (data: KnuflData, updated: SessionLog): KnuflData =>
  reconcileMilestones({
    ...data,
    logs: data.logs.map((log) => (log.id === updated.id ? updated : log)),
  }, updated.id);

export const deleteSession = (data: KnuflData, id: string): KnuflData => ({
  ...data,
  logs: data.logs.filter((log) => log.id !== id),
  memories: data.memories.filter((memory) => memory.associatedSessionId !== id),
});

export const memoryDate = (memory: Memory, logs: SessionLog[]): string =>
  logs.find((log) => log.id === memory.associatedSessionId)?.date ?? memory.createdAt.slice(0, 10);

export const calendarDayDifference = (from: string, to: string): number => {
  if (!from || !to) return 0;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
};

export const nextPlannedDate = (planDays: string[], override?: string, now = new Date()): string | undefined => {
  const today = localDateKey(now);
  if (override && override >= today) return override;
  if (!planDays.length) return undefined;
  const mondayIndex = (now.getDay() + 6) % 7;
  for (let offset = 0; offset < 7; offset += 1) {
    const index = (mondayIndex + offset) % 7;
    const dayName = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index];
    if (planDays.includes(dayName)) {
      const date = new Date(now);
      date.setDate(now.getDate() + offset);
      return localDateKey(date);
    }
  }
  return undefined;
};
