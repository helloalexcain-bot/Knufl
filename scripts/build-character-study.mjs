// Reproducible, provisional 3D study. No raster image is transformed or embedded.
// This node-rigged maquette is NOT the approved production sculpt/skin/fur groom.
import { mkdir, writeFile } from 'node:fs/promises';
import * as T from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
};
const scene = new T.Scene();
const material = (color, roughness = .88) => new T.MeshStandardMaterial({ color, roughness, metalness: 0 });
const cream = material('#e7c99f'), light = material('#f2dab7'), muzzle = material('#f7e5c7');
const sage = material('#959783'), brown = material('#80614c'), pad = material('#69604b');
const nose = material('#906047', .48), dark = material('#33241e'), white = material('#fff8e9', .3);
const iris = material('#6b4225', .34), pupil = material('#171914', .2), tongue = material('#bf8278');
const sphere = new T.SphereGeometry(1, 32, 24);
function joint(parent, name, position) {
  const node = new T.Group(); node.name = name; node.position.set(...position); parent.add(node); return node;
}
function ellipsoid(parent, name, mat, position, scale, rotation = [0, 0, 0]) {
  const mesh = new T.Mesh(sphere, mat); mesh.name = name; mesh.position.set(...position); mesh.scale.set(...scale); mesh.rotation.set(...rotation); parent.add(mesh); return mesh;
}
// Fine geometry nap, merged per articulated segment. Kept sparse for mobile;
// the production asset needs an artist-authored baked fur normal/silhouette.
let seed = 61;
const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
function nap(parent, center, scale, count, mat) {
  const pieces = [];
  for (let i = 0; i < count; i++) {
    const y = random() * 2 - 1, angle = random() * Math.PI * 2;
    const v = new T.Vector3(Math.sqrt(1-y*y)*Math.cos(angle), y, Math.sqrt(1-y*y)*Math.sin(angle));
    const p = new T.Vector3(v.x*scale[0],v.y*scale[1],v.z*scale[2]).add(new T.Vector3(...center));
    const g = new T.ConeGeometry(.008 + random()*.006, .024 + random()*.025, 3);
    g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0), v)); g.translate(...p.toArray()); pieces.push(g);
  }
  const mesh = new T.Mesh(mergeGeometries(pieces), mat); mesh.name = `${parent.name}_nap`; parent.add(mesh);
  pieces.forEach(g => g.dispose());
}
const root = joint(scene, 'Study_Root', [0, 0, 0]);
const hips = joint(root, 'Study_Hips', [0, .8, 0]);
const torso = joint(hips, 'Study_Torso', [0, .65, 0]);
ellipsoid(torso, 'Round_body', cream, [0,0,0], [.88,1.05,.63]);
ellipsoid(torso, 'Sage_belly', sage, [0,-.06,.50], [.57,.69,.18]);
nap(torso,[0,0,0],[.88,1.05,.63],900,cream);
const head = joint(torso, 'Study_Head', [0,1.12,.03]);
head.scale.setScalar(1.06);
ellipsoid(head,'Head',light,[0,.14,0],[.79,.70,.62]);
nap(head,[0,.14,0],[.79,.70,.62],650,light);
for (const side of [-1,1]) {
  ellipsoid(head,`Ear_${side}`,cream,[side*.60,.69,-.10],[.235,.255,.17]);
  ellipsoid(head,`Inner_ear_${side}`,brown,[side*.60,.69,.055],[.145,.16,.065]);
  ellipsoid(head,`Cheek_${side}`,muzzle,[side*.36,-.05,.41],[.32,.26,.26]);
  const eye = joint(head, side<0?'Study_EyeL':'Study_EyeR', [side*.29,.29,.536]);
  ellipsoid(eye,`Eye_white_${side}`,white,[0,0,0],[.155,.196,.10],[0,side*.13,side*-.08]);
  const gaze = joint(eye,side<0?'Study_GazeL':'Study_GazeR',[side*-.015,-.015,.085]);
  ellipsoid(gaze,`Iris_${side}`,iris,[0,0,0],[.094,.125,.027]);
  ellipsoid(gaze,`Pupil_${side}`,pupil,[0,0,.022],[.054,.083,.018]);
  ellipsoid(gaze,`Glint_${side}`,white,[-.021,.035,.039],[.022,.025,.009]);
  const brow = joint(head,side<0?'Study_BrowL':'Study_BrowR',[side*.29,.57,.50]);
  ellipsoid(brow,`Brow_${side}`,brown,[0,0,0],[.183,.055,.058],[0,0,side*.17]);
}
// A separate jaw and mouth cavity: actual depth/movement, not a painted overlay.
const jaw = joint(head, 'Study_Jaw', [0,-.23,.39]);
ellipsoid(jaw,'Lower_muzzle',muzzle,[0,-.025,.16],[.34,.105,.17]);
const mouth = joint(head,'Study_Mouth',[0,-.205,.75]);
ellipsoid(mouth,'Mouth_cavity',dark,[0,0,0],[.26,.026,.026]);
ellipsoid(mouth,'Tongue',tongue,[0,-.012,.014],[.12,.009,.014]);
const smileCurve=new T.CatmullRomCurve3([new T.Vector3(-.29,-.165,.70),new T.Vector3(-.15,-.225,.76),new T.Vector3(0,-.24,.78),new T.Vector3(.15,-.225,.76),new T.Vector3(.29,-.165,.70)]);
const smile=new T.Mesh(new T.TubeGeometry(smileCurve,24,.012,6,false),dark);smile.name='Quiet_smile';head.add(smile);
ellipsoid(head,'MuzzleL',muzzle,[-.17,-.04,.62],[.23,.16,.16]);
ellipsoid(head,'MuzzleR',muzzle,[.17,-.04,.62],[.23,.16,.16]);
ellipsoid(head,'Nose',nose,[0,.048,.765],[.17,.10,.09],[.08,0,0]);
ellipsoid(head,'NostrilL',dark,[-.065,.025,.84],[.022,.016,.009]);
ellipsoid(head,'NostrilR',dark,[.065,.025,.84],[.022,.016,.009]);
for(const side of [-1,1]) {
  const arm = joint(torso,side<0?'Study_ShoulderL':'Study_ShoulderR',[side*.70,.45,-.015]);
  ellipsoid(arm,`Upper_arm_${side}`,cream,[side*.20,-.30,.04],[.31,.48,.32],[0,0,side*.32]);
  const paw = joint(arm,side<0?'Study_PawL':'Study_PawR',[side*.29,-.62,.12]);
  ellipsoid(paw,`Paw_${side}`,cream,[0,-.05,.05],[.30,.32,.31]);
  ellipsoid(paw,`Paw_pad_${side}`,pad,[0,-.07,.355],[.16,.15,.05]);
  for(let digit=0;digit<3;digit++) {
    const x=(digit-1)*.14, y=.12+(digit===1?.025:0);
    ellipsoid(paw,`Finger_${side}_${digit}`,cream,[x,y,.18],[.102,.13,.15]);
    ellipsoid(paw,`Finger_pad_${side}_${digit}`,pad,[x,y,.31],[.068,.085,.032]);
  }
  nap(arm,[side*.20,-.30,.04],[.31,.48,.32],150,cream);
  const leg = joint(root,side<0?'Study_LegL':'Study_LegR',[side*.48,.49,0]);
  ellipsoid(leg,`Leg_${side}`,cream,[0,0,0],[.40,.48,.42]);
  ellipsoid(leg,`Foot_${side}`,light,[side*.04,-.27,.26],[.38,.23,.48]);
  for(let toe=0;toe<3;toe++) ellipsoid(leg,`Toe_${side}_${toe}`,light,[(toe-1)*.16,-.29,.61],[.12,.155,.19]);
}
root.userData = { status:'provisional-articulated-study', approvedProductionAsset:false, authoring:'Knufl procedural maquette; original approved PNGs unmodified' };
scene.updateMatrixWorld(true);
const buffer = await new GLTFExporter().parseAsync(scene,{ binary:true, trs:true });
await mkdir('public/character',{recursive:true});
await writeFile('public/character/knufl-study.glb',Buffer.from(buffer));
console.log(`Articulated study: ${buffer.byteLength} bytes. Production sculpt/skin/fur not supplied.`);
