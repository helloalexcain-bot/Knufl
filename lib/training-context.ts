// One compact, factual view shared by the browser, tools and Realtime prompt.
// These are records, not instructions. Planned reps never become completed reps.
type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const list = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
const pick = (r: Row, ...keys: string[]): unknown => keys.map(k => r[k]).find(v => v !== undefined && v !== null);
const nameOf = (r: Row) => String(pick(r, 'display_name', 'displayName', 'name') ?? '');
const loadModeOf = (value:unknown) => typeof value === 'string' ? value.replaceAll('_','-') : null;
export const exerciseNameMatches = (candidate: string, requested: string): boolean => {
  const normalized = (v: string) => v.toLowerCase().trim().replace(/^bench$/, 'bench press');
  return normalized(candidate) === normalized(requested);
};

export function trainingContextFrom(value: unknown) {
  const ctx = row(value);
  const session = row(ctx.session ?? ctx.activeSession);
  const persisted = row(row(ctx.preferences).training_context ?? ctx.trainingState);
  const draft = row(persisted.draft);
  const exercises = list(ctx.exercises);
  const sets = list(ctx.completedSets ?? ctx.sets).filter(s => !s.deleted_at && !s.deletedAt);
  const latest = sets.at(-1);
  const inSession = persisted.sessionId === session.id;
  const superset = inSession && persisted.superset === true;
  const selected = inSession ? exercises.find(e => e.id === persisted.exerciseId) : undefined;
  const active = selected ?? (exercises.length === 1 ? exercises[0] : undefined);
  const exerciseSets = active ? sets.filter(s => pick(s, 'exercise_instance_id', 'exerciseInstanceId') === active.id) : [];
  const previous = exerciseSets.at(-1);
  const draftExercises = list(draft.exercises);
  return {
    sessionId: typeof session.id === 'string' ? session.id : null,
    sessionVersion: session.version ?? null,
    localDate: pick(session, 'local_date', 'localDate') ?? null,
    timezone: session.timezone ?? row(ctx.preferences).timezone ?? 'UTC',
    draft: draftExercises.length ? { title: draft.title, exercises: draftExercises, superset: draft.superset === true } : null,
    superset,
    activeExercise: active ? {
      id: active.id, name: nameOf(active),
      plannedSets: pick(active, 'planned_sets', 'plannedSets') ?? null,
      plannedReps: pick(active, 'planned_reps', 'plannedReps') ?? null,
      load: previous ? pick(previous, 'load') ?? null : pick(active, 'planned_load', 'plannedLoad') ?? null,
      loadUnit: previous ? pick(previous, 'load_unit', 'loadUnit') ?? null : pick(active, 'planned_load_unit', 'plannedLoadUnit') ?? null,
      loadMode: loadModeOf(previous ? pick(previous, 'load_mode', 'loadMode') : pick(active, 'planned_load_mode', 'plannedLoadMode')),
      restSeconds: pick(active, 'rest_seconds', 'restSeconds') ?? null,
      completedSetCount: exerciseSets.length, nextSetPosition: Math.max(0,...exerciseSets.map(s=>Number(pick(s,'set_order','setOrder'))||0)) + 1,
      latestSetId: previous?.id ?? null,
    } : null,
    exerciseChoices: exercises.map(e => ({ id: e.id, name: nameOf(e) })),
    needsExerciseSelection: exercises.length > 1 && !active,
    latestCompletedSet: latest ? {
      id: latest.id, version: latest.version, exerciseId: pick(latest, 'exercise_instance_id', 'exerciseInstanceId'),
      reps: latest.reps, load: latest.load ?? null, loadUnit: pick(latest, 'load_unit', 'loadUnit') ?? null,
      loadMode: pick(latest, 'load_mode', 'loadMode') ?? null,
    } : null,
    rest: ctx.latestRestTimer ?? ctx.restTimer ?? null,
  };
}
export type TrainingContext = ReturnType<typeof trainingContextFrom>;

export function setReceipt(saved: Row, exerciseName: string): string {
  const load = typeof saved.load === 'number' ? ` at ${saved.load} ${pick(saved, 'load_unit', 'loadUnit') ?? ''}` : ' reps';
  const position = Number(pick(saved, 'set_order', 'setOrder'));
  return `${exerciseName}: ${saved.reps}${load}, saved.${position === 1 ? ' First set done.' : Number.isInteger(position) && position > 0 ? ` Set ${position} done.` : ''}`;
}

export function resolvedSetArguments(args: Row, context: unknown): Row {
  const ctx = row(context);
  const training = trainingContextFrom(ctx);
  const choices = list(ctx.exercises);
  const requested = typeof args.exercise === 'string' ? args.exercise : '';
  const matches = requested ? choices.filter(e => exerciseNameMatches(nameOf(e), requested)) : [];
  const explicit = requested ? (matches.length === 1 ? matches[0] : undefined)
    : args.exerciseInstanceId ? choices.find(e => e.id === args.exerciseInstanceId) : undefined;
  const target = requested || args.exerciseInstanceId ? explicit : choices.find(e => e.id === training.activeExercise?.id);
  if (!target || !training.sessionId) throw new Error('Which exercise did you complete?');
  const focused = trainingContextFrom({ ...ctx, trainingState: { sessionId: training.sessionId, exerciseId: target.id }, preferences: { ...row(ctx.preferences), training_context: { sessionId: training.sessionId, exerciseId: target.id } } });
  const active = focused.activeExercise!;
  const latest = list(ctx.completedSets ?? ctx.sets).filter(s => !s.deleted_at && !s.deletedAt && pick(s, 'exercise_instance_id', 'exerciseInstanceId') === target.id).at(-1);
  if (args.sameAgain && (!latest || latest.id !== training.latestCompletedSet?.id)) throw new Error('Which completed set should I repeat?');
  if (args.loadUnit && args.loadUnit !== active.loadUnit && args.load === undefined) throw new Error('What load did you use in those units?');
  const unweighted = args.loadMode === 'bodyweight' || args.loadMode === 'not-applicable';
  const resolved: Row = { ...args, sessionId: training.sessionId, exerciseInstanceId: target.id,
    ...(args.sameAgain ? { reps: latest!.reps } : {}),
    load: unweighted ? undefined : args.load ?? active.load ?? undefined, loadUnit: unweighted ? undefined : args.loadUnit ?? active.loadUnit ?? undefined,
    loadMode: args.loadMode ?? active.loadMode ?? undefined };
  delete resolved.exercise; delete resolved.sameAgain;
  if (typeof resolved.reps !== 'number') throw new Error('How many reps did you complete?');
  return resolved;
}
