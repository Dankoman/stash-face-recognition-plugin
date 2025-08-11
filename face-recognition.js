// face-recognition.js — rendera overlay för /recognize (topp‑K)
// - Flyttad knapp åt vänster (krockar mindre med Stash-ikonen)
// - Full overlay-rendering av resultat från /recognize (data: [{box:{x,y,w,h}, candidates:[{name,score}]}])
// - Filtrering på min_confidence
// - Ingen StashDB-bild ännu (steg 2)

(function(){
  const LS_KEY = 'face_recognition_plugin_settings';

  let pluginSettings = {
    api_url: 'http://127.0.0.1:5000',
    api_timeout: 30,
    show_confidence: true,
    min_confidence: 30,
    auto_add_performers: false,
    create_new_performers: false,
    max_suggestions: 3,
    image_source: 'both',
    stashdb_endpoint: 'https://stashdb.org/graphql',
    stashdb_api_key: ''
  };

  // ---------------- Settings ----------------
  function loadSettings(){
    try{ const raw = localStorage.getItem(LS_KEY); if (raw) pluginSettings = { ...pluginSettings, ...JSON.parse(raw) }; }catch{}
  }
  function saveSettings(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(pluginSettings)); }catch{} }
  function notify(msg, isErr=false){
    const el = document.createElement('div'); el.textContent = msg;
    Object.assign(el.style,{position:'fixed',bottom:'16px',right:'16px',background:isErr?'#b91c1c':'#166534',color:'#fff',padding:'10px 12px',borderRadius:'10px',zIndex:10000});
    document.body.appendChild(el); setTimeout(()=>el.remove(),2200);
  }

  // ---------------- Video & container ----------------
  function findVideoElement(){
    for (const sel of ['.video-js video','.vjs-tech','video[playsinline]','video']){ const el=document.querySelector(sel); if (el) return el; }
    return null;
  }
  function findVideoContainer(){
    const video = findVideoElement(); if (!video) return null;
    let c = video.parentElement;
    while (c && c!==document.body){ const cs=getComputedStyle(c); if (cs.position==='relative'||cs.position==='absolute') return c; c=c.parentElement; }
    return video.parentElement||null;
  }

  // ---------------- Overlay render ----------------
  function clearOverlay(){ document.querySelectorAll('.frp-overlay').forEach(n=>n.remove()); }
  function ensureOverlay(){
    const cont = findVideoContainer() || document.body;
    let ov = cont.querySelector('.frp-overlay'); if (ov) return ov;
    ov = document.createElement('div'); ov.className='frp-overlay';
    const cs = getComputedStyle(cont);
    if (cont===document.body || cs.position==='static'){ Object.assign(ov.style,{position:'fixed',inset:0}); } else { ov.style.position='absolute'; ov.style.inset='0'; }
    ov.style.pointerEvents='none'; ov.style.zIndex='2147483647';
    cont.appendChild(ov); return ov;
  }

  function renderRecognizeOverlay(items){
    clearOverlay();
    const video = findVideoElement(); if (!video){ notify('Ingen video för overlay', true); return; }
    const ov = ensureOverlay();

    const vrect = video.getBoundingClientRect();
    const vw = video.clientWidth || vrect.width; const vh = video.clientHeight || vrect.height;
    const iw = video.videoWidth || vw; const ih = video.videoHeight || vh;
    const sx = vw/iw, sy = vh/ih;

    items.forEach(face => {
      const {x,y,w,h} = face.box;
      const left = vrect.left + x*sx; const top = vrect.top + y*sy;
      const width = w*sx; const height = h*sy;

      const box = document.createElement('div');
      box.className='frp-face-box';
      Object.assign(box.style,{position:'fixed',left:left+'px',top:top+'px',width:width+'px',height:height+'px',border:'2px solid rgba(0,200,255,0.9)',borderRadius:'6px',boxShadow:'0 0 0 1px rgba(0,0,0,0.35), 0 4px 14px rgba(0,0,0,0.4)'});

      // Förslagslista
      const sug = document.createElement('div');
      sug.className='frp-suggestions';
      Object.assign(sug.style,{position:'absolute',left:'0px',top:'100%',marginTop:'6px',minWidth:'220px',maxWidth:'360px',background:'rgba(18,18,18,0.92)',color:'#f2f2f2',border:'1px solid rgba(255,255,255,0.12)',borderRadius:'10px',overflow:'hidden',backdropFilter:'blur(6px)',pointerEvents:'auto'});

      // Filtrera kandidater mot min_confidence
      const minPct = Math.max(0, Math.min(100, pluginSettings.min_confidence));
      const cands = (face.candidates||[]).filter(c=> (c.score*100)>=minPct).slice(0, pluginSettings.max_suggestions||3);

      if (cands.length===0){
        const row=document.createElement('div'); row.className='frp-suggestion';
        Object.assign(row.style,{display:'flex',alignItems:'center',gap:'10px',padding:'8px 10px',lineHeight:'1.25',borderBottom:'1px solid rgba(255,255,255,0.06)'});
        row.textContent='(inga kandidater över tröskeln)'; sug.appendChild(row);
      } else {
        cands.forEach(c=>{
          const row=document.createElement('div'); row.className='frp-suggestion';
          Object.assign(row.style,{display:'flex',alignItems:'center',gap:'10px',padding:'8px 10px',lineHeight:'1.25',borderBottom:'1px solid rgba(255,255,255,0.06)'});
          const span=document.createElement('span');
          span.textContent = pluginSettings.show_confidence ? `${c.name} (${Math.round(c.score*100)}%)` : c.name;
          span.style.fontSize='14px'; span.style.fontWeight='600'; span.style.color='#f7f7f7'; span.style.textShadow='0 1px 1px rgba(0,0,0,0.4)';
          row.appendChild(span); sug.appendChild(row);
        });
        // ta bort sista border
        const last = sug.lastElementChild; if (last) last.style.borderBottom='none';
      }

      box.appendChild(sug); ov.appendChild(box);
    });
  }

  // ---------------- UI-knapp ----------------
  function createPluginButton(){
    const btn=document.createElement('button'); btn.className='face-recognition-button';
    btn.textContent='Identifiera Ansikten'; btn.type='button';
    btn.style.marginRight='150px'; // flytta bort från Stash-ikonen
    btn.addEventListener('click', performFaceRecognition); return btn;
  }
  function addPluginButton(){
    const c=findVideoContainer();
    if (c && c.querySelector('.face-recognition-button')) return;
    if (document.body.querySelector('.face-recognition-button.fallback')) return;
    const btn=createPluginButton();
    if (c){ c.appendChild(btn); } else { btn.classList.add('fallback'); Object.assign(btn.style,{position:'fixed',top:'12px',right:'60px',zIndex:9999}); document.body.appendChild(btn);} }

  // ---------------- Huvudflöde ----------------
  async function performFaceRecognition(){
    try{
      const video=findVideoElement(); if (!video) return notify('Ingen video hittad', true);
      if (!video.videoWidth||!video.videoHeight) return notify('Video ej redo', true);

      const canvas=document.createElement('canvas'); canvas.width=video.videoWidth; canvas.height=video.videoHeight;
      const ctx=canvas.getContext('2d'); ctx.drawImage(video,0,0);
      const blob=await new Promise(res=>canvas.toBlob(res,'image/jpeg',0.92)); if(!blob) return notify('Kunde inte skapa bild',true);

      const fd=new FormData(); fd.append('image', new File([blob],'frame.jpg',{type:'image/jpeg'}));

      const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(), Math.max(3,pluginSettings.api_timeout)*1000);
      const url=`${pluginSettings.api_url.replace(/\/$/,'')}/recognize?top_k=${pluginSettings.max_suggestions||3}`;
      const resp=await fetch(url,{method:'POST',body:fd,signal:ctrl.signal}); clearTimeout(to);
      if(!resp.ok) throw new Error(`API-fel ${resp.status}`);
      const data=await resp.json();
      // data: array av { box:{x,y,w,h}, candidates:[{name,score}] }
      renderRecognizeOverlay(Array.isArray(data)?data:[]);
      notify(`Fick svar för ${Array.isArray(data)?data.length:0} ansikten`);
    }catch(e){ console.error(e); notify('Fel vid ansiktsigenkänning', true); }
  }

  // ---------------- Init ----------------
  function init(){
    loadSettings();
    if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', addPluginButton); else addPluginButton();
    const mo=new MutationObserver(()=>setTimeout(addPluginButton,600)); mo.observe(document.body,{childList:true,subtree:true});
    let tries=0; const iv=setInterval(()=>{ try{addPluginButton();}catch{} if(findVideoElement()||++tries>20) clearInterval(iv); },1000);
  }
  try{ init(); }catch(e){ console.error('Initfel:',e); }
})();