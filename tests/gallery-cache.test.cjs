const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');

function setup(){
 const requests=[],currentLabels=['New identity'],currentBinary=new Float32Array(512).buffer;
 const ctx={URL,self:{FaceRecognitionAssetBase:'https://stash.example/plugin/face/assets/face/',FaceRecognitionCore:{}},importScripts(){},fetch:async(url,options)=>{
  requests.push({url,options});
  const fresh=options.cache==='reload';
  return {ok:true,json:async()=>fresh?currentLabels:['Old identity'],arrayBuffer:async()=>fresh?currentBinary:new ArrayBuffer(0)};
 }};
 const source=fs.readFileSync('assets/recognition-worker.js','utf8');
 vm.runInNewContext(source+'\nglobalThis.readGalleryForTest=read;globalThis.assetForTest=asset;',ctx);
 return {requests,currentLabels,currentBinary,read:ctx.readGalleryForTest,asset:ctx.assetForTest};
}

test('gallery loading refreshes both labels and embeddings instead of accepting cached release data',async()=>{
 const t=setup();
 const [binary,labels]=await Promise.all([t.read('gallery/embeddings.bin'),t.read('gallery/labels.json','json')]);
 assert.equal(binary,t.currentBinary);assert.equal(labels,t.currentLabels);
 assert.deepEqual(t.requests.map(({url})=>url),[
  'https://stash.example/plugin/face/assets/face/gallery/embeddings.bin',
  'https://stash.example/plugin/face/assets/face/gallery/labels.json'
 ]);
 for(const {options} of t.requests){assert.equal(options.cache,'reload');assert.equal(options.credentials,'same-origin');}
 // Model and runtime URLs retain their existing cache keys.
 assert.equal(t.asset('models/w600k_r50.onnx'),'https://stash.example/plugin/face/assets/face/models/w600k_r50.onnx');
 assert.equal(t.asset('runtime/ort.webgpu.bundle.min.mjs'),'https://stash.example/plugin/face/assets/face/runtime/ort.webgpu.bundle.min.mjs');
});
