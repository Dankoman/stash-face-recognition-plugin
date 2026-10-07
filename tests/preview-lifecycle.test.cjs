const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const test=require('node:test');
const source=fs.readFileSync('face-recognition.js','utf8');
const entry="init().catch(e => console.error('Initialization error:', e));";
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
function setup({deferred=false,settings={},imageURL='https://example.test/synthetic.png'}={}) {
 const body=new Element();body.root=true;
 const row=body.appendChild(new Element());row.rect={left:900,top:400,width:200,height:30};
 const video=body.appendChild(new Element('video'));video.videoWidth=1600;video.videoHeight=900;video.clientWidth=1600;video.clientHeight=900;
 const timers=new Map();let nextTimer=0,resolveURL;
 const pendingURL=new Promise(resolve=>resolveURL=resolve);
 const window=new Element();window.innerWidth=1600;window.innerHeight=900;window.location={origin:'https://stash.test',protocol:'https:'};
 const signals=[];
 const ctx={window,document:{body,querySelector:()=>video,querySelectorAll:s=>body.querySelectorAll(s),createElement:tag=>new Element(tag)},getComputedStyle:()=>({position:'static'}),AbortController,URL,console:{error(){},warn(){}},setTimeout:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),FaceRecognitionStandalone:{metadataClient:()=>({})},testSettings:settings,loadImageURL:(name,signal)=>{signals.push(signal);return deferred?pendingURL:Promise.resolve(imageURL);}};
 vm.runInNewContext(source.replace(entry,`pluginSettings={...pluginSettings,...testSettings};resolveImageURL=loadImageURL;addPerformerToSceneByName=async()=>{};globalThis.api={attach:attachHoverPreview,clear:clearOverlay,render:renderRecognizeOverlay};`),ctx);
 const fire=delay=>{const found=[...timers].find(([id,t])=>t.delay===delay);assert.ok(found,`timer ${delay}`);timers.delete(found[0]);return found[1].fn();};
 const previews=()=>body.querySelectorAll('.frp-preview');
 return {api:ctx.api,row,body,window,fire,previews,resolveURL,signals};
}
const candidates=[{name:'Synthetic A',score:.9},{name:'Synthetic B',score:.3},{name:'Synthetic C',score:.1},{name:'Synthetic D',score:.05}];
const settle=()=>new Promise(setImmediate);
const result=()=>[{box:{x:100,y:100,w:200,h:200},candidates}];
test('top-K 3 displays three candidates and previews even below the confidence threshold',async()=>{
 const t=setup({settings:{max_suggestions:3,min_confidence:45}});t.api.render(result());
 await settle();
 const rows=t.body.querySelector('.frp-suggestions').children;
 assert.equal(rows.length,3);
 assert.deepEqual(rows.map(row=>row.querySelector('img').alt),candidates.slice(0,3).map(c=>`Preview for ${c.name}`));
 assert.equal(rows[0].querySelector('.frp-candidate-warning'),null);
 assert.equal(rows[1].querySelector('.frp-candidate-warning').textContent,'Uncertain suggestion');
 assert.equal(rows[2].querySelector('.frp-candidate-warning').textContent,'Uncertain suggestion');
 for(const row of rows) {
  const img=row.querySelector('img');assert.equal(img.src,'https://example.test/synthetic.png');img.onload();assert.equal(img.style.display,'block');
 }
});
test('top-K 1 limits the list and its previews to one candidate',async()=>{
 const t=setup({settings:{max_suggestions:1}});t.api.render(result());await settle();
 assert.equal(t.body.querySelector('.frp-suggestions').children.length,1);
 assert.equal(t.signals.length,1);
});
test('missing or broken pictures keep the candidate selectable with a visible placeholder',async()=>{
 for(const imageURL of [null,'https://example.test/broken.png']) {
  const t=setup({imageURL,settings:{max_suggestions:1}});t.api.render(result());await settle();
  const row=t.body.querySelector('.frp-candidate'),img=row.querySelector('img');
  if(imageURL) img.onerror();
  assert.equal(row.querySelector('.frp-candidate-preview').children[0].textContent,'No image available');
  await row.emit('click');assert.equal(t.body.querySelector('.frp-face-box'),null);
 }
});
test('clearing the list aborts all pending thumbnail lookups and ignores late results',async()=>{
 const t=setup({deferred:true});t.api.render(result());await Promise.resolve();
 const imgs=t.body.querySelectorAll('img');assert.equal(imgs.length,3);
 t.api.clear();assert.ok(t.signals.every(signal=>signal.aborted));
 t.resolveURL('https://example.test/synthetic.png');await settle();
 assert.ok(imgs.every(img=>!img.src && img.onload===null));
 assert.equal(t.body.querySelector('.frp-overlay'),null);
});
test('the candidate list stays inside the viewport when its face is near an edge',async()=>{
 const t=setup();t.api.render(result());
 const box=t.body.querySelector('.frp-face-box');box.rect={left:1450,top:800,width:100,height:80};
 await box.emit('mouseenter');const sug=box.querySelector('.frp-suggestions'),rect=sug.getBoundingClientRect();
 assert.ok(rect.left>=12 && rect.right<=t.window.innerWidth-12);
 assert.ok(rect.top>=12 && rect.bottom<=t.window.innerHeight-12);
});
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
