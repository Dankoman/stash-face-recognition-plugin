const test=require('node:test'), assert=require('node:assert/strict');
const core=require('../assets/recognition-core.js');
test('similarity alignment recovers scale, translation and rotation',()=>{
 const points=core.reference.map(([x,y])=>[(x-7)/2,(y+3)/2]);
 const [a,b,tx,ty]=core.alignment(points);
 assert.ok(Math.abs(a-2)<1e-6);assert.ok(Math.abs(b)<1e-6);assert.ok(Math.abs(tx-7)<1e-6);assert.ok(Math.abs(ty+3)<1e-6);
 const rotated=core.reference.map(([x,y])=>[y,-x]);
 const [ra,rb]=core.alignment(rotated);assert.ok(Math.abs(ra)<1e-6);assert.ok(Math.abs(rb-1)<1e-6);
});
test('nonmaximum suppression removes duplicates but preserves separate faces',()=>{
 const faces=[{box:[0,0,100,100],score:.9},{box:[1,1,99,99],score:.8},{box:[150,0,250,100],score:.7}];
 assert.deepEqual(core.nms(faces),[faces[0],faces[2]]);
});
test('SCRFD decoding uses interleaved anchors and returns original image coordinates',()=>{
 const out={},names=['448','471','494','451','474','497','454','477','500'];
 [8,16,32].forEach((stride,s)=>{
  const n=(640/stride)**2*2;
  out[names[s]]={data:new Float32Array(n)};out[names[s+3]]={data:new Float32Array(n*4)};out[names[s+6]]={data:new Float32Array(n*10)};
 });
 const i=(2*80+3)*2+1;out['448'].data[i]=.9;out['451'].data.set([1,2,3,4],i*4);
 const faces=core.decode(out,1280,640);assert.equal(faces.length,1);assert.deepEqual(faces[0].box,[32,0,96,48]);
 assert.deepEqual(faces[0].landmarks,Array(5).fill([48,16]));
});
test('KNN mirrors cosine-distance voting and per-candidate similarity',()=>{
 const query=new Float32Array(512);query[0]=1;
 const database=new Float32Array(3*512);database[0]=1;database[512]=.8;database[513]=.6;database[1025]=1;
 const labels=['A','B','C'];core.normalizeGallery(database,labels);
 const result=core.rank(query,database,labels,3);
 assert.equal(result[0].name,'A');assert.equal(result[0].score,1);assert.equal(result[1].name,'B');assert.ok(Math.abs(result[1].score-.8)<1e-5);assert.equal(result[2].score,0);
 assert.equal(core.rank(query,database,labels,1).length,1);
});
test('invalid databases, zero embeddings and dimensions fail clearly',()=>{
 assert.throws(()=>core.normalizeGallery(new Float32Array(512),['A']),/Empty embedding/);
 assert.throws(()=>core.normalizeGallery(new Float32Array(513),['A']),/database/);
 assert.throws(()=>core.rank(new Float32Array(2),new Float32Array(2),['A']),/dimension/);
});
