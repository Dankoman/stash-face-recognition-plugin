const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');
const source=fs.readFileSync('face-recognition.js','utf8');
const entry="init().catch(e => console.error('Initfel:', e));";
class Element {
 constructor(tag='div') { this.tagName=tag;this.children=[];this.listeners=new Map();this.style={setProperty(k,v){this[k]=v;}};this.dataset={}; }
 get isConnected() { return this.root||!!this.parentNode?.isConnected; }
 get lastElementChild() {return this.children.at(-1);}
 appendChild(el) {el.parentNode=this;this.children.push(el);return el;}
 remove() {if(this.parentNode) this.parentNode.children=this.parentNode.children.filter(el=>el!==this);this.parentNode=null;}
 addEventListener(event,fn) {if(!this.listeners.has(event))this.listeners.set(event,new Set());this.listeners.get(event).add(fn);}
 removeEventListener(event,fn) {this.listeners.get(event)?.delete(fn);}
 async emit(event) {await Promise.all([...this.listeners.get(event)||[]].map(fn=>fn({preventDefault(){},stopPropagation(){}})));}
 querySelectorAll(selector) {return this.children.flatMap(el=>[...(selector.startsWith('.')?el.className===selector.slice(1):el.tagName===selector)?[el]:[],...el.querySelectorAll(selector)]);}
 querySelector(selector) {return this.querySelectorAll(selector)[0]||null;}
 getBoundingClientRect() {
  if(!this.isConnected)return {left:0,top:0,right:0,bottom:0,width:0,height:0};
  const rect=this.rect||{left:parseFloat(this.style.left)||0,top:parseFloat(this.style.top)||0,width:parseFloat(this.style.width)||350,height:this.tagName==='div'?500:30};
  return {...rect,right:rect.left+rect.width,bottom:rect.top+rect.height};
 }
}
function setup({deferred=false}={}) {
 const body=new Element();body.root=true;
 const row=body.appendChild(new Element());row.rect={left:900,top:400,width:200,height:30};
 const video=body.appendChild(new Element('video'));video.videoWidth=1600;video.videoHeight=900;video.clientWidth=1600;video.clientHeight=900;
 const timers=new Map();let nextTimer=0,resolveURL;
 const pendingURL=new Promise(resolve=>resolveURL=resolve);
 const window=new Element();window.innerWidth=1600;window.innerHeight=900;window.location={origin:'https://stash.test',protocol:'https:'};
 const ctx={window,document:{body,querySelector:()=>video,querySelectorAll:s=>body.querySelectorAll(s),createElement:tag=>new Element(tag)},getComputedStyle:()=>({position:'static'}),AbortController,URL,console:{error(){},warn(){}},setTimeout:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),FaceRecognitionStandalone:{metadataClient:()=>({})},loadImageURL:()=>deferred?pendingURL:Promise.resolve('https://example.test/synthetic.png')};
 vm.runInNewContext(source.replace(entry,`resolveImageURL=loadImageURL;addPerformerToSceneByName=async()=>{};globalThis.api={attach:attachHoverPreview,clear:clearOverlay,render:renderRecognizeOverlay};`),ctx);
 const fire=delay=>{const found=[...timers].find(([id,t])=>t.delay===delay);assert.ok(found,`timer ${delay}`);timers.delete(found[0]);return found[1].fn();};
 const previews=()=>body.querySelectorAll('.frp-preview');
 return {api:ctx.api,row,body,window,fire,previews,resolveURL};
}
test('a loaded preview is positioned beside its row before becoming visible',async()=>{
 const t=setup();t.api.attach(t.row,'Synthetic Person');await t.row.emit('mouseenter');await t.fire(150);
 const tip=t.previews()[0];assert.equal(tip.style.visibility,'hidden');
 tip.querySelector('img').onload();
 assert.equal(tip.style.visibility,'visible');
 assert.equal(parseFloat(tip.style.left)+350+12,t.row.rect.left);
 assert.equal(parseFloat(tip.style.top),165);
});
test('removing an overlay while its image URL is loading cannot create an orphan preview',async()=>{
 const t=setup({deferred:true});t.api.attach(t.row,'Synthetic Person');await t.row.emit('mouseenter');const loading=t.fire(150);
 t.api.clear();t.row.remove();t.resolveURL('https://example.test/synthetic.png');await loading;
 assert.equal(t.previews().length,0);
});
test('a late image load after disposal cannot resurrect the preview',async()=>{
 const t=setup();const dispose=t.api.attach(t.row,'Synthetic Person');await t.row.emit('mouseenter');await t.fire(150);
 const tip=t.previews()[0],lateLoad=tip.querySelector('img').onload;
 dispose();t.row.remove();lateLoad();
 assert.equal(t.previews().length,0);
});
test('mouseleave and viewport movement remove previews and allow a fresh hover',async()=>{
 const t=setup();t.api.attach(t.row,'Synthetic Person');
 for(const event of ['mouseleave','scroll','resize']) {
  await t.row.emit('mouseenter');await t.fire(150);t.previews()[0].querySelector('img').onload();
  await (event==='mouseleave'?t.row:t.window).emit(event);assert.equal(t.previews().length,0,event);
 }
});
test('an old image callback cannot remove a newer hover preview',async()=>{
 const t=setup();t.api.attach(t.row,'Synthetic Person');await t.row.emit('mouseenter');await t.fire(150);
 const oldLoad=t.previews()[0].querySelector('img').onload;
 await t.row.emit('mouseleave');await t.row.emit('mouseenter');await t.fire(150);
 const fresh=t.previews()[0];oldLoad();assert.equal(t.previews()[0],fresh);
});
test('successful candidate selection cancels a pending image load before removing its row',async()=>{
 const t=setup();t.api.render([{box:{x:100,y:100,w:200,h:200},candidates:[{name:'Synthetic Person',score:0.9}]}]);
 const box=t.body.querySelector('.frp-face-box'),row=box.querySelector('.frp-suggestions').children[0];
 await row.emit('mouseenter');await t.fire(150);
 const lateLoad=t.previews()[0].querySelector('img').onload;
 await row.emit('click');lateLoad();
 assert.equal(t.body.querySelector('.frp-face-box'),null);
 assert.equal(t.previews().length,0);
});
test('the overlay timeout clears visible previews and their event listeners',async()=>{
 const t=setup();t.api.render([{box:{x:100,y:100,w:200,h:200},candidates:[{name:'Synthetic Person',score:0.9}]}]);
 const row=t.body.querySelector('.frp-suggestions').children[0];await row.emit('mouseenter');await t.fire(150);t.previews()[0].querySelector('img').onload();
 t.fire(30000);assert.equal(t.previews().length,0);assert.equal(row.listeners.get('mouseenter').size,0);
});
