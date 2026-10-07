/* Pure geometry and ranking, shared by the worker and Node verification. */
(function (root) {
  'use strict';
  const reference = [[30.2946,51.6963],[65.5318,51.5014],[48.0252,71.7366],[33.5493,92.3655],[62.7299,92.2041]];
  function iou(a, b) {
    const overlap = Math.max(0, Math.min(a[2], b[2])-Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3])-Math.max(a[1], b[1]));
    const union = (a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-overlap;
    return union > 0 ? overlap/union : 0;
  }
  function nms(faces, threshold = .4) {
    const kept = [];
    for (const face of [...faces].sort((a,b)=>b.score-a.score)) {
      if (!kept.some(other=>iou(face.box,other.box)>threshold)) kept.push(face);
    }
    return kept;
  }
  function decode(outputs, width, height, threshold = .4) {
    const faces = [];
    const names = ['448','471','494','451','474','497','454','477','500'];
    for (let s=0; s<3; s++) {
      const stride = [8,16,32][s], grid = 640/stride;
      const scores = outputs[names[s]].data, boxes = outputs[names[s+3]].data, kps = outputs[names[s+6]].data;
      if (scores.length !== grid*grid*2 || boxes.length !== scores.length*4 || kps.length !== scores.length*10) throw new Error('Oväntat SCRFD-utdataformat');
      for (let i=0; i<scores.length; i++) {
        if (scores[i]<threshold) continue;
        const cell = Math.floor(i/2), x = (cell%grid)*stride, y = Math.floor(cell/grid)*stride;
        const sx = width/640, sy = height/640;
        const box = [(x-boxes[i*4]*stride)*sx,(y-boxes[i*4+1]*stride)*sy,(x+boxes[i*4+2]*stride)*sx,(y+boxes[i*4+3]*stride)*sy];
        const landmarks = Array.from({length:5},(_,k)=>[(x+kps[i*10+k*2]*stride)*sx,(y+kps[i*10+k*2+1]*stride)*sy]);
        faces.push({box, landmarks, score:scores[i]});
      }
    }
    return nms(faces);
  }
  // Least-squares similarity transform from source landmarks to ArcFace pixels.
  function alignment(points, target = reference) {
    const mean = p=>p.reduce((m,v)=>[m[0]+v[0]/p.length,m[1]+v[1]/p.length],[0,0]);
    const [px,py] = mean(points), [qx,qy] = mean(target);
    let den=0, a=0, b=0;
    points.forEach(([x,y],i)=>{
      x-=px; y-=py; const u=target[i][0]-qx, v=target[i][1]-qy;
      den+=x*x+y*y; a+=x*u+y*v; b+=x*v-y*u;
    });
    if (den<1e-8) throw new Error('Ogiltiga ansiktslandmärken');
    a/=den; b/=den;
    return [a,b,qx-a*px+b*py,qy-b*px-a*py];
  }
  function alignedTensor(rgba, width, height, points) {
    const [a,b,tx,ty] = alignment(points), determinant = a*a+b*b;
    if (determinant<1e-12) throw new Error('Ansiktet kunde inte justeras');
    const out = new Float32Array(3*112*112);
    const sample = (x,y,c)=>x<0||y<0||x>=width||y>=height ? 0 : rgba[(y*width+x)*4+c];
    for(let y=0;y<112;y++) for(let x=0;x<112;x++) {
      const u=(a*(x-tx)+b*(y-ty))/determinant, v=(-b*(x-tx)+a*(y-ty))/determinant;
      const ix=Math.floor(u), iy=Math.floor(v), dx=u-ix, dy=v-iy;
      for(let c=0;c<3;c++) {
        const value=sample(ix,iy,c)*(1-dx)*(1-dy)+sample(ix+1,iy,c)*dx*(1-dy)+sample(ix,iy+1,c)*(1-dx)*dy+sample(ix+1,iy+1,c)*dx*dy;
        out[c*112*112+y*112+x]=(value-127.5)/127.5;
      }
    }
    return out;
  }
  function normalizeGallery(embeddings, labels, dimension=512) {
    if (!labels.length || embeddings.length!==labels.length*dimension || labels.some(l=>typeof l!=='string'||!l)) throw new Error('Ogiltig igenkänningsdatabas');
    for(let row=0;row<labels.length;row++) {
      let norm=0; const start=row*dimension;
      for(let i=0;i<dimension;i++) { const v=embeddings[start+i]; if(!Number.isFinite(v)) throw new Error('Ogiltig embedding'); norm+=v*v; }
      norm=Math.sqrt(norm);
      if (!norm) throw new Error('Tom embedding');
      for(let i=0;i<dimension;i++) embeddings[start+i]/=norm;
    }
    return embeddings;
  }
  function rank(query, embeddings, labels, topK=3) {
    const dim=query.length;
    if(dim!==512 || embeddings.length!==labels.length*dim) throw new Error('Embeddingdimensionerna stämmer inte');
    const norm=Math.sqrt(query.reduce((sum,v)=>sum+v*v,0));
    if(!norm || !Number.isFinite(norm)) throw new Error('Ogiltigt ansiktsresultat');
    const k=Math.min(labels.length,Math.max(1,Math.min(10,Math.floor(topK)||3))), nearest=[];
    for(let row=0;row<labels.length;row++) {
      let dot=0; for(let i=0;i<dim;i++) dot+=query[i]*embeddings[row*dim+i];
      const distance=Math.max(0,Math.min(2,1-dot/norm));
      if(nearest.length===k && distance>=nearest[k-1].distance) continue;
      nearest.push({name:labels[row],distance}); nearest.sort((a,b)=>a.distance-b.distance); if(nearest.length>k) nearest.pop();
    }
    const votes=new Map();
    for(const {name,distance} of nearest) {
      const vote=votes.get(name)||{name,weight:0,distance:Infinity};
      vote.weight+=1/Math.max(distance,1e-6); vote.distance=Math.min(vote.distance,distance); votes.set(name,vote);
    }
    return [...votes.values()].sort((a,b)=>b.weight-a.weight || a.name.localeCompare(b.name)).map(v=>({name:v.name,score:Math.max(0,1-v.distance)}));
  }
  const api = {reference,iou,nms,decode,alignment,alignedTensor,normalizeGallery,rank};
  if(typeof module!=='undefined') module.exports=api; else root.FaceRecognitionCore=api;
})(globalThis);
