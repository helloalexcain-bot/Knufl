import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvedSetArguments, trainingContextFrom, setReceipt } from './training-context.ts';
import { parseToolCall } from '../server/knufl-api/contracts.ts';
const bench={id:'bench',display_name:'Bench press',planned_sets:3,planned_reps:8,planned_load:60,planned_load_unit:'kg',planned_load_mode:'total',rest_seconds:90};
const row={id:'set-1',exercise_instance_id:'bench',reps:8,load:60,load_unit:'kg',load_mode:'total',set_order:1,version:1};
const initial={session:{id:'session',version:1,local_date:'2026-09-06',timezone:'Europe/London'},exercises:[bench],completedSets:[] as Record<string,unknown>[],preferences:{training_context:{sessionId:'session',exerciseId:'bench',superset:false}}};
test('bench first/next shorthand inherits established facts but never planned reps',()=>{
  const args=resolvedSetArguments({operationKey:'first-set',reps:8},initial);
  assert.equal(args.exerciseInstanceId,'bench');assert.equal(args.load,60);assert.equal(args.loadUnit,'kg');
  assert.equal(trainingContextFrom(initial).activeExercise?.nextSetPosition,1);
  assert.throws(()=>resolvedSetArguments({operationKey:'missing'},initial),/How many reps/);
  assert.throws(()=>resolvedSetArguments({sameAgain:true},initial),/Which completed set/);
  const call=parseToolCall({name:'record_set',arguments:args});
  assert.equal(call.name,'record_set');
  if(call.name==='record_set')assert.equal(call.arguments.reps,8);
  assert.equal(setReceipt(row,'Bench press'),'Bench press: 8 at 60 kg, saved. First set done.');
});
test('correction, same-again and JSON reconnect preserve last identity and actual load',()=>{
  const ctx=JSON.parse(JSON.stringify({...initial,completedSets:[{...row,reps:6,version:2}]}));
  const facts=trainingContextFrom(ctx);
  assert.equal(facts.latestCompletedSet?.id,'set-1');assert.equal(facts.latestCompletedSet?.version,2);
  assert.equal(facts.activeExercise?.nextSetPosition,2);
  assert.equal(resolvedSetArguments({sameAgain:true},ctx).reps,6);
  assert.equal(resolvedSetArguments({reps:8},ctx).load,60);
});
test('explicit exercise switch works; supersets and duplicate names never guess',()=>{
  const ctx={...initial,exercises:[bench,{...bench,id:'row',display_name:'Row',planned_load:40}],preferences:{training_context:{sessionId:'session',exerciseId:null,superset:true}}};
  assert.equal(trainingContextFrom(ctx).needsExerciseSelection,true);
  assert.throws(()=>resolvedSetArguments({reps:8},ctx),/Which exercise/);
  assert.equal(resolvedSetArguments({exercise:'Row',reps:8},ctx).load,40);
  assert.equal(resolvedSetArguments({reps:8},{...ctx,preferences:{training_context:{...ctx.preferences.training_context,exerciseId:'row'}}}).exerciseInstanceId,'row');
  assert.throws(()=>resolvedSetArguments({exercise:'Bench press',reps:8},{...ctx,exercises:[bench,{...bench,id:'bench-2'}]}),/Which exercise/);
  assert.throws(()=>resolvedSetArguments({exercise:'Incline bench press',reps:8},initial),/Which exercise/);
});
test('deleted latest set is excluded; unit changes need a number; bodyweight clears inherited load',()=>{
  const ctx={...initial,completedSets:[row,{...row,id:'deleted',reps:10,set_order:2,deleted_at:'2026-09-06'}]};
  assert.equal(trainingContextFrom(ctx).latestCompletedSet?.id,'set-1');
  assert.equal(resolvedSetArguments({sameAgain:true},ctx).reps,8);
  assert.throws(()=>resolvedSetArguments({reps:8,loadUnit:'lb'},ctx),/What load/);
  assert.equal(resolvedSetArguments({reps:8,loadMode:'bodyweight'},ctx).load,undefined);
  assert.equal(resolvedSetArguments({reps:8},{...initial,exercises:[{...bench,planned_load_mode:'per_dumbbell'}]}).loadMode,'per-dumbbell');
});
test('a persisted draft survives reconnect without becoming completed work',()=>{
  const draft={title:'Bench day',exercises:[{name:'Bench press',sets:3,reps:8,load:60,loadUnit:'kg'}],superset:false};
  const facts=trainingContextFrom({preferences:{training_context:{draft}},exercises:[],completedSets:[]});
  assert.deepEqual(facts.draft,draft);assert.equal(facts.latestCompletedSet,null);assert.equal(facts.sessionId,null);
});
