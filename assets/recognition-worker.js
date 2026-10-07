'use strict';
importScripts('recognition-core.js');
const core = self.FaceRecognitionCore;
let ort, detector, recognizer, embeddings, labels, backend, initialization;
const asset = path => new URL(path, self.location.href).href;
async function read(path, kind) {
  const response = await fetch(asset(path), {credentials:'same-origin'});
  if(!response.ok) throw new Error(`Pluginfil saknas: ${path} (${response.status})`);
  return kind==='json' ? response.json() : response.arrayBuffer();
}
async function sessions(provider) {
  if(detector) await detector.release();
  if(recognizer) await recognizer.release();
  detector=recognizer=null;
  const options={executionProviders:[provider],graphOptimizationLevel:'all'};
  detector=await ort.InferenceSession.create(asset('models/det_10g.onnx'),options);
  recognizer=await ort.InferenceSession.create(asset('models/w600k_r50.onnx'),options);
  // Run both real models before reporting readiness; GPU kernels may fail only
  // at inference time even when session construction succeeds.
  for(const [session,size] of [[detector,640],[recognizer,112]]) {
    const tensor=new ort.Tensor('float32',new Float32Array(3*size*size),[1,3,size,size]);
    let result;
    try {
      result=await session.run({[session.inputNames[0]]:tensor});
      if(session===recognizer && result[session.outputNames[0]].data.length!==512) throw new Error('Oväntat ArcFace-utdataformat');
    } finally { tensor.dispose(); if(result) Object.values(result).forEach(t=>t.dispose()); }
  }
  backend=provider;
}
async function initialize(preference='auto') {
  if(initialization) return initialization;
  initialization=(async()=>{
    ort=await import(asset('runtime/ort.webgpu.bundle.min.mjs'));
    ort.env.wasm.wasmPaths=asset('runtime/');
    ort.env.wasm.numThreads=1; // Works without COOP/COEP or SharedArrayBuffer.
    ort.env.wasm.proxy=false;
    const [binary,names]=await Promise.all([read('gallery/embeddings.bin'),read('gallery/labels.json','json')]);
    embeddings=core.normalizeGallery(new Float32Array(binary),names); labels=names;
    let gpu=false;
    if(preference!=='cpu' && self.navigator.gpu) { try { gpu=!!(await self.navigator.gpu.requestAdapter()); } catch {} }
    if(gpu) {
      try { await sessions('webgpu'); }
      catch(error) { self.postMessage({status:'GPU kunde inte startas. Använder CPU.'}); await sessions('wasm'); }
    } else await sessions('wasm');
    return {backend,model_loaded:true,identities:new Set(labels).size,samples:labels.length};
  })();
  try { return await initialization; } catch(error) { initialization=null; throw error; }
}
async function analyze(bitmap, topK) {
  const width=bitmap.width,height=bitmap.height;
  if(!width||!height||width*height>16000000) throw new Error('Bildrutan är för stor eller ogiltig');
  const canvas=new OffscreenCanvas(width,height), ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0);
  const rgba=ctx.getImageData(0,0,width,height).data;
  const small=new OffscreenCanvas(640,640), sc=small.getContext('2d',{willReadFrequently:true});
  sc.drawImage(bitmap,0,0,640,640);
  const pixels=sc.getImageData(0,0,640,640).data, data=new Float32Array(3*640*640);
  for(let i=0;i<640*640;i++) for(let c=0;c<3;c++) data[c*640*640+i]=(pixels[i*4+c]-127.5)/128;
  const tensor=new ort.Tensor('float32',data,[1,3,640,640]);
  let outputs;
  try { outputs=await detector.run({[detector.inputNames[0]]:tensor}); }
  finally { tensor.dispose(); }
  let faces;
  try { faces=core.decode(outputs,width,height); }
  finally { Object.values(outputs).forEach(t=>t.dispose()); }
  const results=[];
  for(const face of faces) {
    const input=new ort.Tensor('float32',core.alignedTensor(rgba,width,height,face.landmarks),[1,3,112,112]);
    let output;
    try {
      output=await recognizer.run({[recognizer.inputNames[0]]:input});
      const candidates=core.rank(output[recognizer.outputNames[0]].data,embeddings,labels,topK);
      const [x1,y1,x2,y2]=face.box;
      const x=Math.max(0,x1),y=Math.max(0,y1);
      results.push({box:{x,y,w:Math.max(0,Math.min(width,x2)-x),h:Math.max(0,Math.min(height,y2)-y)},candidates});
    } finally { input.dispose(); if(output) Object.values(output).forEach(t=>t.dispose()); }
  }
  return results;
}
// Serialize requests: ONNX sessions and their GPU buffers are reused.
let queue=Promise.resolve();
self.onmessage=({data})=>{
  queue=queue.then(async()=>{
    try {
      const health=await initialize(data.backend);
      let result=health;
      if(data.type==='recognize') {
        try { result=await analyze(data.bitmap,data.topK); }
        catch(error) {
          if(backend!=='webgpu') throw error;
          self.postMessage({status:'GPU-analys misslyckades. Försöker med CPU.'});
          await sessions('wasm'); result=await analyze(data.bitmap,data.topK);
        }
      }
      self.postMessage({id:data.id,result,backend});
    } catch(error) { self.postMessage({id:data.id,error:error.message}); }
    finally { if(data.bitmap) data.bitmap.close(); }
  });
};
