/** Wiki chasm route; puzzle symbols and scenery come from the live cache. */
module.exports=function registerChasm({api,stage,advance,held,give,val,play,replace,ATTRIBUTES}){
 const {PrivateArea,Boundary,Location,Equipment}=api.core;
 const ORBS_ATTRIBUTE='while-guthix-sleeps:elemental-orbs',BLOCKS_ATTRIBUTE='while-guthix-sleeps:elemental-blocks';
 const ROUTE_ATTRIBUTE='while-guthix-sleeps:cavity-route',ROCKS_ATTRIBUTE='while-guthix-sleeps:uncovered-braziers';
 ATTRIBUTES.push(ORBS_ATTRIBUTE,BLOCKS_ATTRIBUTE,ROUTE_ATTRIBUTE,ROCKS_ATTRIBUTE);
 const MOVARIO=13567,DARVE=13570,LIGHT=5435,LANTERN=4702,ROBES=[29566,29568,29570];
 const SPADE=952,HAMMER=2347,CHISEL=1755,REMAINS=[53809,53810];
 const WALLS=[53623,53624],WALL_DOWN=53676,CAVITIES=[53631,53632,53633],HOLES=[53830,53831,53832];
 const CUBE=54084,CUBE_READY=53693,OPENING=53622,SKULL=54082;
 const ELEMENTS=[
  {name:'air',orb:573,block:29552,recess:53617,brazier:53819,mechanism:53629,room:[4109,5112],hole:53832},
  {name:'earth',orb:575,block:29553,recess:53616,rocks:53731,brazier:53732,mechanism:53625,room:[4143,5102],hole:53831},
  {name:'fire',orb:569,block:29554,recess:53615,rocks:53727,brazier:53728},
  {name:'water',orb:571,block:29555,recess:53618,brazier:53820,mechanism:53627,room:[4126,5080],hole:53830},
 ];
 const sessions=new WeakMap(),actors=new WeakMap(),prefix='into-the-chasm-';
 const visible=e=>e.definition?.id??api.core.ObjectDefinition.forPlayer(e.objectId,e.player)?.id??e.objectId;
 const loc=(x,y,z=0)=>new Location(x,y,z),dressed=p=>ROBES.every(id=>p.getEquipment().contains(id));
 function sync(p){
  const orbs=val(p,ORBS_ATTRIBUTE),blocks=val(p,BLOCKS_ATTRIBUTE);
  p.getPacketSender().sendVarbit(10825,blocks);
  p.getPacketSender().sendVarbit(10820,stage(p)>=760?0:(orbs&8)?(blocks&4?1:2):(blocks&4?3:4));
 }
 class ChasmArea extends PrivateArea{
  constructor(p){super([0,1,2].map(z=>new Boundary(4032,4095,4544,4607,z)).concat([new Boundary(4096,4159,5056,5119,0)]));this.player=p;this.cast=[];}
  canAttack(){return false;}
  postLeave(m,logout){if(m===this.player){for(const n of this.cast)api.removeNpc(n);sessions.delete(m);if(logout&&stage(m)<900)m.moveTo(loc(3229,9527,2));}super.postLeave(m,logout);}
 }
 function enter(p,tile=loc(4064,4600)){
  let area=sessions.get(p);if(!area){area=new ChasmArea(p);sessions.set(p,area);area.enter(p);}
  if(!val(p,ROUTE_ATTRIBUTE)){
   const order=[0,1,3];for(let i=2;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
   p.setAttribute(ROUTE_ATTRIBUTE,1+order[0]+order[1]*4+order[2]*16);
  }
  p.moveTo(tile);advance(p,720);sync(p);
  // These quest locs are created by OSRS scripts and have no static map placement.
  if(!area.scenery){
   for(const[id,x,y,z,type=10,face=0]of [[53809,4067,4600,0,22,2],[53810,4070,4605,0,22,3],[53727,4072,4604,0,10,3],[53731,4056,4602,0,10,3],[53819,4053,4589,0,10,3],[53820,4073,4588,0,10,3],[53615,4062,4554,0],[53616,4056,4557,0],[53617,4068,4557,0],[CUBE,4063,4552,2],[53625,4147,5094,0],[53627,4137,5071,0],[53629,4113,5098,0],[53830,4126,5081,0],[53831,4143,5103,0],[53832,4109,5113,0]])replace(p,id,[x,y,z],type,face);
   area.scenery=true;
  }
  // After the quest Movario and Darve are gone; the light creature still carries players back up.
  if(!area.cast.length)for(const[id,x,y]of stage(p)>=900?[[LIGHT,4063,4602]]:[[LIGHT,4063,4602],[MOVARIO,4062,4599],[DARVE,4061,4599]]){
   const n=api.spawnNpc({id,x,y,z:0,wanderRadius:0,owner:p,ownerOnly:true});area.enter(n);area.cast.push(n);
  }
  for(const [i,e]of ELEMENTS.entries())if(e.rocks&&(val(p,ROCKS_ATTRIBUTE)&(1<<i))){
   const tile=e.name==='fire'?[4072,4604,0]:[4056,4602,0];replace(p,e.brazier,tile,10,3);
  }
 }
 function clear(p){for(const n of actors.get(p)||[])api.removeNpc(n);actors.delete(p);}
 function mapChange({player:p}){
  clear(p);const l=p.getLocation();if(stage(p)>=700&&l.getZ()===2&&l.getX()>=3200&&l.getX()<3264&&l.getY()>=9472&&l.getY()<9536){
   actors.set(p,(stage(p)>=900?[[LIGHT,3228,9525]]:[[MOVARIO,3229,9528],[DARVE,3228,9528],[LIGHT,3228,9525]]).map(([id,x,y])=>api.spawnNpc({id,x,y,z:2,wanderRadius:0,owner:p,ownerOnly:true})));
  }sync(p);
 }
 function talk({player:p,npcId}){
  if(stage(p)<700||![MOVARIO,DARVE].includes(npcId))return false;
  if(npcId===DARVE){play(p,npcId,prefix+'talking-to-darve');return true;}
  if(p.getLocation().getZ()===0){play(p,npcId,prefix+'talking-to-movario-after-arriving-at-the-bottom-of-the-chasm');return true;}
  const v=stage(p)>700?'talking-to-movario-in-disguise-talking-to-him-again-'+(dressed(p)?'in-disguise':'undisguised'):'talking-to-movario-in-disguise'+(dressed(p)?'':'-talking-to-him-undisguised');play(p,npcId,prefix+v);return true;
 }
 function line(e){if(stage(e.player)===700&&e.npcId===MOVARIO&&e.text.startsWith('Okay, fine! Given I have no choice'))e.after=()=>advance(e.player,710);}
 function light(e){if(e.itemId!==LANTERN||e.target.getId()!==LIGHT||stage(e.player)<700||stage(e.player)<900&&e.target.getLocation().getZ()===2&&e.target.getLocation().getY()<9524)return;e.handled=true;if(stage(e.player)===700){e.player.sendMessage('Speak to Movario about reaching the bottom first.');return;}play(e.player,LIGHT,prefix+'attracting-a-light-creature');}
 function attract({player:p,npcId,npc}){if(npcId!==LIGHT||stage(p)<710||stage(p)<900&&npc.getLocation().getZ()===2&&npc.getLocation().getY()<9524)return false;if(p.getLocation().getZ()===0){p.moveTo(loc(3229,9527,2));return true;}if(!held(p,LANTERN)){p.sendMessage('You need a lit sapphire lantern to attract the creature.');return true;}play(p,LIGHT,prefix+'attracting-a-light-creature');return true;}
 function action({player:p,stepId}){if(stepId==='uRkrGI'&&stage(p)>=710){enter(p);play(p,MOVARIO,prefix+'arriving-at-the-bottom-of-the-chasm');}if(stepId==='Q7DQ2x'&&stage(p)>=700)p.moveTo(loc(3250,9530,2));}
 function remains(e){const id=visible(e);if(!sessions.has(e.player)||!REMAINS.includes(id))return false;for(const item of id===REMAINS[1]?[SPADE]:[HAMMER,CHISEL])give(e.player,item);return true;}
 function search(e){
  if(!sessions.has(e.player))return false;const id=visible(e),element=ELEMENTS.find(a=>a.recess===id||(id===SKULL||[53619,53620,53621].includes(id))&&a.name==='water');
  if(element){e.player.sendMessage('The recess bears the symbol of '+element.name+'.');const i=ELEMENTS.indexOf(element);if((val(e.player,ORBS_ATTRIBUTE)&(1<<i))&&!(val(e.player,BLOCKS_ATTRIBUTE)&(1<<i)))give(e.player,element.block);return true;}
  const mech=ELEMENTS.find(a=>a.mechanism===id||a.mechanism+1===id);if(mech){e.player.sendMessage('The mechanism bears the symbol of '+mech.name+'.');return true;}
  const brazier=ELEMENTS.find(a=>a.brazier===id);if(brazier){e.player.sendMessage('An '+brazier.name+' orb is set in the brazier. A hammer and chisel could extract it.');return true;}
  if(id===CUBE||id===CUBE_READY){if(val(e.player,BLOCKS_ATTRIBUTE)===15){advance(e.player,760);sync(e.player);play(e.player,MOVARIO,prefix+'inspecting-the-stone-cube');}return true;}return false;
 }
 function use(e){
  const p=e.player;if(!sessions.has(p))return false;const id=visible(e),item=e.itemId;
  const rock=ELEMENTS.find(a=>a.rocks===id);
  if(rock&&item===SPADE){const i=ELEMENTS.indexOf(rock);p.setAttribute(ROCKS_ATTRIBUTE,val(p,ROCKS_ATTRIBUTE)|(1<<i));const l=e.object.getLocation();replace(p,rock.brazier,[l.getX(),l.getY(),l.getZ()],10,3);p.sendMessage('You uncover a brazier.');return true;}
  const brazier=ELEMENTS.find(a=>a.brazier===id);
  if(brazier&&item===CHISEL){if(!held(p,HAMMER)){p.sendMessage('You need a hammer as well as a chisel.');return true;}give(p,brazier.orb);return true;}
  const element=ELEMENTS.find(a=>a.orb===item);
  if(element&&[...ELEMENTS.map(a=>a.recess),SKULL,53619,53620,53621].includes(id)){
   const correct=id===element.recess||element.name==='water'&&[SKULL,53619,53620,53621].includes(id);
   if(!correct){p.sendMessage('This orb does not match the symbol on the recess.');return true;}
   p.getInventory().deleteNumber(item,1);give(p,element.block);p.setAttribute(ORBS_ATTRIBUTE,val(p,ORBS_ATTRIBUTE)|(1<<ELEMENTS.indexOf(element)));sync(p);return true;
  }
  const block=ELEMENTS.find(a=>a.block===item);if(!block)return false;
  const top=[SKULL,53618,53619,53620,53621].includes(id)&&e.object.getLocation().getZ()===2;
  if(top&&block.name==='fire'||id===block.mechanism){p.getInventory().deleteNumber(item,1);p.setAttribute(BLOCKS_ATTRIBUTE,val(p,BLOCKS_ATTRIBUTE)|(1<<ELEMENTS.indexOf(block)));sync(p);p.sendMessage('The elemental block slots into place.');return true;}
  if(top||ELEMENTS.some(a=>a.mechanism===id)){p.sendMessage('The block does not match this mechanism.');return true;}return false;
 }
 function useItem(e){if(use(e))e.handled=true;}
 function route(e){
  if(!sessions.has(e.player))return;const id=e.definition?.id??e.objectId;
  // The sockets sit inside the skull models; interact from their exposed northern lip.
  const tiles={53615:[4062,4556],53616:[4056,4559],53617:[4068,4559]};
  if(tiles[id])e.destination={x:tiles[id][0],y:tiles[id][1],z:0};
 }
 function climb(e){
  const p=e.player,id=visible(e);if(!sessions.has(p))return false;const l=e.object.getLocation();
  if(WALLS.includes(id)){p.moveTo(loc(id===WALLS[0]?4061:4060,id===WALLS[0]?4554:4552,l.getZ()+1));return true;}
  if(id===WALL_DOWN){p.moveTo(loc(l.getX(),l.getZ()===2?4552:4555,l.getZ()-1));return true;}
  const index=CAVITIES.indexOf(id);if(index>=0){
   if(p.getEquipment().get(Equipment.WEAPON_SLOT)?.getId()>0||p.getEquipment().get(Equipment.SHIELD_SLOT)?.getId()>0){p.sendMessage('Unequip your weapon and shield before crawling into the cavity.');return true;}
   const route=val(p,ROUTE_ATTRIBUTE)-1,element=ELEMENTS[(route>>(index*2))&3];p.moveTo(loc(...element.room));return true;
  }
  const hole=HOLES.indexOf(id);if(hole>=0){const element=ELEMENTS.findIndex(a=>a.hole===id),route=val(p,ROUTE_ATTRIBUTE)-1;const cavity=[0,1,2].find(i=>((route>>(i*2))&3)===element);p.moveTo(loc([4069,4063,4057][cavity],cavity===1?4555:4558));return true;}
  if(id===OPENING&&stage(p)>=760){api.emitCustomEvent('wgs:enter-temple',{player:p});return true;}return false;
 }
 function login(e){const l=e.player.getLocation();if(stage(e.player)>=900&&l.getX()>=4032&&l.getX()<=4095&&l.getY()>=4544&&l.getY()<=4607){enter(e.player,l.clone());mapChange(e);return;}if((l.getX()>=4032&&l.getX()<=4095&&l.getY()>=4544&&l.getY()<=4607)||(l.getX()>=4096&&l.getX()<=4159&&l.getY()>=5056&&l.getY()<=5119))e.player.moveTo(loc(3229,9527,2));mapChange(e);}
 function logout({player}){clear(player);}
 api.onNpcInteraction('Movario',{'Talk-to':talk});
 api.onNpcInteraction('Darve',{'Talk-to':talk});
 api.onNpcInteraction('Light creature',{Attract:attract});
 api.onItemOnNpc(light,{noted:false});
 api.onItemOnObject(useItem,{noted:false});
 api.onObjectRoute(route);
 api.onObjectInteraction('Skeletal remains',{Search:remains});
 for(const name of ['Brazier','Recessed block','Recessed blocks','Recesses','Mechanism','Stone cube'])api.onObjectInteraction(name,{Search:search,Inspect:search});
 api.onObjectInteraction('Wall',{'Climb-up':climb,'Jump-down':climb});
 api.onObjectInteraction('Cavity',{Enter:climb});
 api.onObjectInteraction('Hole',{Exit:climb});
 api.onObjectInteraction('Opening',{'Climb-through':climb});
 // The Guthixian temple teleport's arrival (plugins/bosses/tormenteddemons/Scroll.TormentedDemons.js).
 api.onCustomEvent('wgs:enter-chasm',({player:p,tile})=>{if(stage(p)>=900)enter(p,tile);});
 api.onCustomEvent('wgs:return-chasm',({player:p})=>{if(stage(p)>=760){enter(p);p.moveTo(loc(4063,4553,2));}});
 api.onCustomEvent('npc-dialogue:line',line);
 api.onCustomEvent('npc-dialogue:action',action);
 api.onPlayerMapSquareChange(mapChange);
 api.onPlayerLogin(login);
 api.onPlayerLogout(logout);
 return {ELEMENTS,sync,enter,use,climb,search,line,route,sessions};
};
