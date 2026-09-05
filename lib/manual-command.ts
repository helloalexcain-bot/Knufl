import type { ToolName } from './demo-engine';

export interface ManualAction {
  name: ToolName;
  arguments: Record<string, unknown>;
}

export type ManualInterpretation =
  | { status: 'actions'; actions: ManualAction[] }
  | { status: 'clarify'; message: string }
  | { status: 'conversation'; message: string };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

const numberFrom = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parts = value.toLocaleLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  if (!parts.length || parts.some((part) => !(part in NUMBER_WORDS))) return undefined;
  let total = 0;
  for (const part of parts) {
    if (part === 'hundred') total = Math.max(1, total) * 100;
    else total += NUMBER_WORDS[part];
  }
  return total;
};

const NUMBER = '(\\d+(?:\\.\\d+)?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)';

const titleCase = (value: string): string => value
  .trim()
  .replace(/\btoday\b/gi, '')
  .replace(/[,.]+$/g, '')
  .trim()
  .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());

export function interpretManualCommand(raw: string): ManualInterpretation {
  const text = raw.trim();
  const normalized = text.toLocaleLowerCase().replace(/[’]/g, "'");
  if (!normalized) return { status: 'conversation', message: '' };

  const plan = new RegExp(`^(.+?)(?:,|\\s)+(?:today(?:,|\\s)+)?${NUMBER}\\s+sets?\\s+of\\s+${NUMBER}(?:\\s+reps?)?\\s+at\\s+${NUMBER}\\s*(kg|kilos?|kilograms?|lb|lbs|pounds?)(?:[,\\s]+${NUMBER}\\s*(?:seconds?|secs?)\\s+rest)?`, 'i').exec(text);
  if (plan) {
    const exercise = titleCase(plan[1].trim().toLocaleLowerCase() === 'bench' ? 'bench press' : plan[1]);
    const sets = numberFrom(plan[2]);
    const reps = numberFrom(plan[3]);
    const load = numberFrom(plan[4]);
    const restSeconds = numberFrom(plan[6]);
    if (!sets || !reps || load === undefined) {
      return { status: 'clarify', message: 'I caught the exercise, but not every set, rep and load number.' };
    }
    return {
      status: 'actions',
      actions: [{
        name: 'draft_workout',
        arguments: {
          title: `${exercise} session`,
          exercises: [{
            name: exercise,
            sets,
            reps,
            load,
            loadUnit: /lb|pound/i.test(plan[5]) ? 'lb' : 'kg',
            loadMode: 'total',
            ...(restSeconds ? { restSeconds } : {}),
          }],
        },
      }],
    };
  }

  const completedSet = new RegExp(`(?:set\\s+done|first\\s+set\\s+done|done)[,\\s]+${NUMBER}(?:\\s+reps?)?`, 'i').exec(text);
  if (completedSet) {
    const reps = numberFrom(completedSet[1]);
    return reps
      ? { status: 'actions', actions: [{ name: 'record_set', arguments: { reps } }] }
      : { status: 'clarify', message: 'How many reps did you complete?' };
  }

  const repsCorrection = new RegExp(`^(?:actually[,\\s]+)?(?:that\\s+was\\s+)?${NUMBER}(?:\\s+reps?)?[.!]?$`, 'i').exec(text);
  if (normalized.startsWith('actually') && repsCorrection) {
    const reps = numberFrom(repsCorrection[1]);
    if (reps) return { status: 'actions', actions: [{ name: 'correct_set', arguments: { reps } }] };
  }

  const explicitRepsCorrection = new RegExp(`(?:actually|correct|change)(?:\\s+that)?(?:\\s+to|\\s+was)?\\s+${NUMBER}\\s+reps?`, 'i').exec(text);
  if (explicitRepsCorrection) {
    const reps = numberFrom(explicitRepsCorrection[1]);
    if (reps) return { status: 'actions', actions: [{ name: 'correct_set', arguments: { reps } }] };
  }

  const loadCorrection = new RegExp(`make\\s+that\\s+${NUMBER}(?:\\s*(kg|kilos?|lb|pounds?))?[,\\s]+not\\s+${NUMBER}`, 'i').exec(text);
  if (loadCorrection) {
    const load = numberFrom(loadCorrection[1]);
    if (load !== undefined) {
      return {
        status: 'actions',
        actions: [{
          name: 'correct_set',
          arguments: { load, ...(/lb|pound/i.test(loadCorrection[2] || '') ? { loadUnit: 'lb' } : {}) },
        }],
      };
    }
  }

  if (/\bsame again\b/i.test(text)) {
    return { status: 'actions', actions: [{ name: 'record_set', arguments: { sameAgain: true } }] };
  }
  if (/\b(?:start|begin) (?:the )?workout\b/i.test(text)) {
    return { status: 'actions', actions: [{ name: 'start_workout', arguments: {} }] };
  }
  if (/\b(?:finish|complete|end) (?:the )?(?:workout|session)\b/i.test(text)) {
    return { status: 'actions', actions: [{ name: 'finish_workout', arguments: {} }] };
  }
  if (/\bundo\b/i.test(text)) {
    return { status: 'actions', actions: [{ name: 'undo_last_action', arguments: {} }] };
  }

  const rest = new RegExp(`${NUMBER}\\s*(?:seconds?|secs?)\\s+(?:of\\s+)?rest|(?:rest|timer)(?:\\s+for)?\\s+${NUMBER}\\s*(?:seconds?|secs?)`, 'i').exec(text);
  if (rest || /\bstart (?:the )?rest\b/i.test(text)) {
    const seconds = numberFrom(rest?.[1] || rest?.[2]);
    return seconds
      ? { status: 'actions', actions: [{ name: 'start_rest_timer', arguments: { durationSeconds: seconds } }] }
      : { status: 'clarify', message: 'How many seconds should I time?' };
  }
  if (/\b(?:how long left|rest status|time left)\b/i.test(text)) {
    return { status: 'actions', actions: [{ name: 'get_rest_status', arguments: {} }] };
  }

  const cardio = new RegExp(`(?:i\\s+)?(?:ran|run|walked|cycled)\\s+${NUMBER}\\s*(km|kilometres?|mi|miles?|m)\\s+(?:in|for)\\s+${NUMBER}\\s*(minutes?|mins?|seconds?|secs?)`, 'i').exec(text);
  if (cardio) {
    const distance = numberFrom(cardio[1]);
    const duration = numberFrom(cardio[3]);
    if (distance && duration) {
      const activity = /walk/i.test(normalized) ? 'walking' : /cycl/i.test(normalized) ? 'cycling' : 'running';
      const distanceUnit = /^mi|mile/i.test(cardio[2]) ? 'mi' : cardio[2].toLocaleLowerCase() === 'm' ? 'm' : 'km';
      const durationSeconds = /min/i.test(cardio[4]) ? duration * 60 : duration;
      return { status: 'actions', actions: [{ name: 'record_cardio', arguments: { activity, distance, distanceUnit, durationSeconds } }] };
    }
  }

  const strengthProgress = /(?:show|how(?:'s| is)|what(?:'s| is)).*?\b([a-z][a-z ]*?)\s+progress\b/i.exec(text);
  if (strengthProgress) {
    const spokenExercise = strengthProgress[1].replace(/^(?:my|the)\s+/, '').trim();
    const exercise = titleCase(spokenExercise.toLocaleLowerCase() === 'bench' ? 'bench press' : spokenExercise);
    return { status: 'actions', actions: [{ name: 'get_progress', arguments: { kind: 'strength', exercise } }] };
  }
  if (/\b(?:run|running) times?\b/i.test(text)) {
    return { status: 'actions', actions: [{ name: 'get_progress', arguments: { kind: 'cardio', activity: 'running' } }] };
  }
  if (/\bcompletion rate\b/i.test(text)) {
    return { status: 'actions', actions: [{ name: 'get_progress', arguments: { kind: 'completion' } }] };
  }
  if (/\b(?:i(?:'m| am) tired|tough day|low energy)\b/i.test(text)) {
    return { status: 'conversation', message: 'Smaller session? We can make room for that.' };
  }

  return {
    status: 'clarify',
    message: 'I can plan a workout, log or correct a set, time a rest, record cardio, or show saved progress. What shall we do?',
  };
}
