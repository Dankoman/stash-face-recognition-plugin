let worker;
async function start(backend) {
 if(worker) worker.terminate();
 const result=document.querySelector('#result'); result.textContent='Laddar modeller…';
 const began=performance.now();
 worker=new Worker('../assets/recognition-worker.js');
 worker.onerror=e=>result.textContent='FEL: '+e.message;
 worker.onmessage=async({data})=>{
  if(data.status) {result.textContent+= '\n'+data.status;return;}
  if(data.error) {result.textContent+='\nFEL: '+data.error;return;}
  if(data.id===1) {
   result.textContent=JSON.stringify(data,null,2)+'\nLaddning: '+Math.round(performance.now()-began)+' ms';
   const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;
   canvas.getContext('2d').fillRect(0,0,320,240);
   const bitmap=await createImageBitmap(canvas);
   worker.postMessage({id:2,type:'recognize',bitmap,topK:3},[bitmap]);
  } else result.textContent+='\nAnalys: '+JSON.stringify(data)+'\nTotal: '+Math.round(performance.now()-began)+' ms';
 };
 worker.postMessage({id:1,type:'health',backend});
}
document.querySelector('#cpu').onclick=()=>start('cpu');document.querySelector('#auto').onclick=()=>start('auto');
