const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(){
 const workers=[],timers=new Map();let next=0, sentResolve; const sent=new Promise(resolve=>{sentResolve=resolve;});
 class Worker{constructor(url){this.url=url;workers.push(this);}postMessage(data,transfer){this.data=data;this.transfer=transfer;sentResolve();}terminate(){this.terminated=true;}}
 const ctx={Worker,console,setTimeout:fn=>{const id=++next;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),createImageBitmap:async()=>({close(){}})};
 vm.runInNewContext(fs.readFileSync('standalone-browser.js','utf8'),ctx);
 return {api:ctx.FaceRecognitionStandalone,workers,timers,sent};
}
test('worker assets are local and initialization errors reject instead of hanging',async()=>{
 const t=setup();const pending=t.api.health('face plugin');
 assert.equal(t.workers[0].url,'/plugin/face%20plugin/assets/face/recognition-worker.js');
 t.workers[0].onerror();await assert.rejects(pending,/CSP/);assert.ok(t.workers[0].terminated);assert.equal(t.timers.size,0);
});
test('timeout terminates the worker and permits a fresh engine on the next request',async()=>{
 const t=setup(),pending=t.api.health('face');t.timers.values().next().value();await assert.rejects(pending,/lång tid/);
 const next=t.api.health('face');assert.equal(t.workers.length,2);
 const worker=t.workers[1];worker.onmessage({data:{id:worker.data.id,result:{model_loaded:true},backend:'wasm'}});
 assert.equal((await next).backend,'wasm');assert.equal(t.timers.size,0);
});
test('a captured frame transfers its bitmap and a model error reaches the caller',async()=>{
 const t=setup(),pending=t.api.recognize('face',{},3,30000);await t.sent;
 const worker=t.workers[0];assert.equal(worker.data.topK,3);assert.equal(worker.transfer.length,1);
 worker.onmessage({data:{id:worker.data.id,error:'model failed'}});await assert.rejects(pending,/model failed/);
});
