'use client';
import { useEffect, useRef, useState } from 'react';
import type { CharacterControllerSnapshot } from '@/lib/character-controller';
import { motionTarget, neutralMotion, stepMotion } from '@/lib/character-motion';
import { STUDY_RIG, type RigMapping, type RigRole } from '@/lib/character-rig-map';
import { Character } from './components';
import type * as Three from 'three';

export function ArticulatedCharacter({ snapshot, name, mapping=STUDY_RIG }: { snapshot:Readonly<CharacterControllerSnapshot>; name:string; mapping?:RigMapping }) {
  const mount=useRef<HTMLSpanElement>(null), live=useRef(snapshot);
  const [state,setState]=useState<'loading'|'ready'|'fallback'>('loading');
  useEffect(()=>{live.current=snapshot;},[snapshot]);
  useEffect(()=>{
    const host=mount.current;
    if(!host) return;
    let disposed=false, frame=0, observer:ResizeObserver|undefined, renderer:Three.WebGLRenderer|undefined, scene:Three.Scene|undefined;
    const disposeScene=(object:Three.Object3D)=>object.traverse(node=>{
      const mesh=node as Three.Mesh;
      mesh.geometry?.dispose();
      if(mesh.material) (Array.isArray(mesh.material)?mesh.material:[mesh.material]).forEach(m=>m.dispose());
    });
    const start=async()=>{
      const [T,{GLTFLoader}]=await Promise.all([import('three'),import('three/addons/loaders/GLTFLoader.js')]);
      if(disposed)return;
      renderer=new T.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.5));
      renderer.outputColorSpace=T.SRGBColorSpace;
      renderer.toneMapping=T.ACESFilmicToneMapping; renderer.toneMappingExposure=1.25;
      renderer.shadowMap.enabled=true; renderer.shadowMap.type=T.PCFSoftShadowMap;
      renderer.domElement.setAttribute('aria-hidden','true'); host.append(renderer.domElement);
      scene=new T.Scene();
      const camera=new T.PerspectiveCamera(32,1,.1,30); camera.position.set(.12,2.05,7.3); camera.lookAt(0,1.72,0);
      scene.add(new T.HemisphereLight('#fff9ea','#9a8969',2.1));
      const light=new T.DirectionalLight('#fff4df',3.3); light.position.set(-3,6,5); light.castShadow=true;
      light.shadow.mapSize.set(1024,1024); light.shadow.camera.left=-3;light.shadow.camera.right=3;light.shadow.camera.top=4;light.shadow.camera.bottom=-3;light.shadow.bias=-.001;scene.add(light);
      const fill=new T.DirectionalLight('#e6eeff',1.15);fill.position.set(3,3,-2);scene.add(fill);
      const floor=new T.Mesh(new T.PlaneGeometry(20,20),new T.ShadowMaterial({opacity:.13}));floor.rotation.x=-Math.PI/2;floor.position.y=-.045;floor.receiveShadow=true;scene.add(floor);
      const gltf=await new GLTFLoader().loadAsync(mapping.asset);
      if(disposed){disposeScene(gltf.scene);return;}
      scene.add(gltf.scene);
      gltf.scene.traverse(n=>{if(n instanceof T.Mesh){n.castShadow=true;n.receiveShadow=true;}});
      const nodes={} as Partial<Record<RigRole,Three.Object3D>>;
      const bases=new Map<Three.Object3D,{position:Three.Vector3;rotation:Three.Euler;scale:Three.Vector3}>();
      for(const [role,nodeName] of Object.entries(mapping.nodes)){
        const node=gltf.scene.getObjectByName(nodeName);
        if(!node)throw new Error(`Missing mapped rig node: ${role}`);
        nodes[role as RigRole]=node; bases.set(node,{position:node.position.clone(),rotation:node.rotation.clone(),scale:node.scale.clone()});
      }
      const morph=(role:'jawOpen'|'blinkLeft'|'blinkRight',value:number)=>{
        const binding=mapping.morphs?.[role];if(!binding)return false;
        const mesh=gltf.scene.getObjectByName(binding.node) as Three.Mesh;
        const index=mesh?.morphTargetDictionary?.[binding.target];
        if(index===undefined||!mesh.morphTargetInfluences)return false;
        mesh.morphTargetInfluences[index]=value;return true;
      };
      const resize=()=>{if(!renderer)return;const width=host.clientWidth,height=host.clientHeight;if(!width||!height)return;renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();};
      observer=new ResizeObserver(resize);observer.observe(host);resize();
      setState('ready');let previous=performance.now(),elapsed=0,pose=neutralMotion();
      const animate=(time:number)=>{
        if(disposed)return;
        const dt=Math.min(.05,(time-previous)/1000);previous=time;
        if(!document.hidden){
          elapsed+=dt*1000;pose=stepMotion(pose,motionTarget(live.current,Date.now(),elapsed),dt);
          for(const [node,base] of bases){node.position.copy(base.position);node.rotation.copy(base.rotation);node.scale.copy(base.scale);}
          if(nodes.torso){nodes.torso.scale.y*=1+pose.breath;nodes.torso.scale.x*=1+pose.breath*.35;nodes.torso.rotation.z+=pose.shift*.18;nodes.torso.position.x+=pose.shift*.15;}
          if(nodes.head){nodes.head.rotation.z+=pose.headTilt-pose.shift*.12;nodes.head.rotation.x+=pose.headNod;}
          if(nodes.jaw)nodes.jaw.rotation.x+=pose.mouth*.18;
          if(!morph('jawOpen',pose.mouth)&&nodes.mouth){nodes.mouth.scale.y*=1+pose.mouth*5;nodes.mouth.position.y-=pose.mouth*.043;}
          if(!morph('blinkLeft',pose.blink)&&nodes.leftEye)nodes.leftEye.scale.y*=1-pose.blink*.94;
          if(!morph('blinkRight',pose.blink)&&nodes.rightEye)nodes.rightEye.scale.y*=1-pose.blink*.94;
          for(const eye of [nodes.leftGaze,nodes.rightGaze])if(eye){eye.position.x+=pose.gazeX;eye.position.y+=pose.gazeY;}
          if(nodes.rightShoulder){nodes.rightShoulder.rotation.z+=pose.paw+pose.tap*.65;nodes.rightShoulder.rotation.x-=pose.tap*.72;}
          if(nodes.rightPaw){nodes.rightPaw.rotation.x-=pose.tap*.23;nodes.rightPaw.rotation.z-=pose.paw*.45;}
          if(nodes.leftShoulder)nodes.leftShoulder.rotation.z-=pose.shift*.20;
          if(nodes.leftBrow)nodes.leftBrow.rotation.z+=pose.headTilt*.5;
          renderer!.render(scene!,camera);
          // Non-sensitive observability for browser QA; actual audio RMS only.
          host.dataset.mouth=pose.mouth.toFixed(3);host.dataset.motion=live.current.motionMode;
        }
        frame=requestAnimationFrame(animate);
      };
      frame=requestAnimationFrame(animate);
    };
    void start().catch(()=>{if(!disposed)setState('fallback');});
    return()=>{disposed=true;cancelAnimationFrame(frame);observer?.disconnect();if(scene)disposeScene(scene);renderer?.dispose();renderer?.domElement.remove();};
  },[mapping]);
  return <span className="articulated-character" ref={mount} data-renderer={state} role="img" aria-label={`${name}, provisional articulated 3D study`}>
    {state!=='ready'&&<Character pose="wave" name={name} animated={false}/>}
    {state==='fallback'&&<span className="rig-fallback">3D unavailable · approved still artwork</span>}
  </span>;
}
