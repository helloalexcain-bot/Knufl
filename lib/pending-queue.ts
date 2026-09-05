'use client';

import type { ToolName } from './demo-engine';

export const PENDING_QUEUE_PREFIX = 'knufl.voice.pending.v1::';
export const MAX_PENDING_OPERATIONS = 100;

export interface PendingToolOperation {
  id: string;
  name: ToolName;
  arguments: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  status: 'pending' | 'conflict';
  error?: string;
}

const keyFor = (accountId: string): string => `${PENDING_QUEUE_PREFIX}${accountId}`;

const isOperation = (value: unknown): value is PendingToolOperation => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PendingToolOperation>;
  return typeof item.id === 'string'
    && typeof item.name === 'string'
    && Boolean(item.arguments && typeof item.arguments === 'object')
    && typeof item.queuedAt === 'string'
    && typeof item.attempts === 'number'
    && (item.status === 'pending' || item.status === 'conflict');
};

export const readPendingOperations = (accountId: string): PendingToolOperation[] => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(keyFor(accountId)) || '[]');
    return Array.isArray(parsed) ? parsed.filter(isOperation) : [];
  } catch {
    return [];
  }
};

export const writePendingOperations = (accountId: string, operations: PendingToolOperation[]): void => {
  window.localStorage.setItem(keyFor(accountId), JSON.stringify(operations));
};

export const enqueuePendingOperation = (
  accountId: string,
  operation: Omit<PendingToolOperation, 'queuedAt' | 'attempts' | 'status'>,
): PendingToolOperation[] => {
  const current = readPendingOperations(accountId);
  if (current.some((item) => item.id === operation.id)) return current;
  if (current.length >= MAX_PENDING_OPERATIONS) {
    throw new Error('The offline queue is full. Reconnect before recording another change.');
  }
  const next = [...current, {
    ...operation,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending' as const,
  }];
  writePendingOperations(accountId, next);
  return next;
};

export const removePendingOperation = (accountId: string, id: string): PendingToolOperation[] => {
  const next = readPendingOperations(accountId).filter((item) => item.id !== id);
  writePendingOperations(accountId, next);
  return next;
};

/** Permanently removes only the deleted account's offline payloads. */
export const clearPendingOperations = (accountId: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(keyFor(accountId));
};

export const markPendingConflict = (accountId: string, id: string, error: string): PendingToolOperation[] => {
  const next = readPendingOperations(accountId).map((item) => item.id === id
    ? { ...item, attempts: item.attempts + 1, status: 'conflict' as const, error }
    : item);
  writePendingOperations(accountId, next);
  return next;
};
