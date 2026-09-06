import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialCharacterSnapshot, reduceCharacterController } from './character-controller.ts';
import { motionTarget, stepMotion, neutralMotion } from './character-motion.ts';
import { STUDY_RIG } from './character-rig-map.ts';
import { readFileSync } from 'node:fs';
test('articulated GLB contains each mapped joint and no embedded static character image',()=>{
  const bytes=readFileSync('public/character/knufl-study.glb');
  assert.equal(bytes.toString('utf8',0,4),'glTF');
  const gltf=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
  for(const name of Object.values(STUDY_RIG.nodes))assert.ok(gltf.nodes.some((n:{name:string})=>n.name===name),name);
  assert.ok(gltf.nodes.filter((n:{mesh?:number})=>n.mesh!==undefined).length>30);
  assert.equal(gltf.images,undefined);
});
test('actual speech amplitude drives mouth; interruption settles rapidly without snapping the pose',()=>{
  let s=reduceCharacterController(createInitialCharacterSnapshot(),{type:'state.changed',state:'speaking',at:0});
  s=reduceCharacterController(s,{type:'speech.amplitude',value:.6,at:100});
  let p=neutralMotion();for(let i=0;i<30;i++)p=stepMotion(p,motionTarget(s,100+i*16,i*16),.016);
  assert.ok(p.mouth>.8);
  s=reduceCharacterController(s,{type:'conversation.interrupted',at:600});
  const first=stepMotion(p,motionTarget(s,616,616),.016);assert.ok(first.mouth>0&&first.mouth<p.mouth);
  for(let i=0;i<30;i++)p=stepMotion(p,motionTarget(s,600+i*16,600+i*16),.016);
  assert.ok(p.mouth<.001);
});
test('reduced motion suppresses idle/gesture repertoire but preserves meaningful speech mouth',()=>{
  let s=reduceCharacterController(createInitialCharacterSnapshot({reducedMotion:true}),{type:'state.changed',state:'speaking'});
  s=reduceCharacterController(s,{type:'speech.amplitude',value:.4});
  const p=motionTarget(s,1000,20000);assert.ok(p.mouth>0);
  for(const k of ['breath','shift','tap','paw','blink','headNod','headTilt'] as const)assert.equal(p[k],0);
});
