// face-recognition.js — bytes‑mode bildhämtning via backend‑proxy (CSP‑safe)
// Den här versionen sätter <img>.src direkt till ditt API med `format=bytes`,
// så att bilden levereras från samma origin som API:et (och inte blockeras av Stash UI:s CSP).
// Högerklick på knappen öppnar en enkel inställningspanel.

(function(){
  const LS_KEY = 'face_recognition_plugin_settings';
  const imageCache = new Map(); // name -> url|null

  let pluginSettings = {
    api_url: 'http://127.0.0.1:5000',
    api_timeout: 30,
    show_confidence: true,
    min_confidence: 30,
    auto_add_performers: false,
    create_new_performers: false,
    max_suggestions: 3,
    image_source: 'both', // local|stashdb|both (skickas till backend)
    stashdb_endpoint: 'https://stashdb.org/graphql'
    // stashdb_api_key hanteras på backend via env
  };

  function loadSettings(){ try{ const raw=localStorage.getItem(LS_KEY); if(raw) pluginSettings={...pluginSettings,...JSON.parse(raw)};}catch{} }
  function saveSettings(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(pluginSettings)); }catch{} }
  function notify(msg,isErr=false){ const el=document.createElement('div'); el.textContent=msg; Object.assign(el.style,{position:'fixed',bottom:'16px',right:'16px',background:isErr?'#b91c1c':'#166534',color:'#fff',padding:'10px 12px',borderRadius:'10px',zIndex:10000}); document.body.appendChild(el); setTimeout(()=>el.remove(),2200); }

  // ---------------- Settings panel (högerklick) ----------------
  function createSettingsPanel(){
    if (document.querySelector('.fr-settings-panel')) return; // en instans åt gången
    const wrap = document.createElement('div');
    wrap.className = 'fr-settings-panel';
    wrap.innerHTML = `
      <div class="fr-sp-head">Face Recognition – Inställningar</div>
      <div class="fr-sp-body">
        <label>API URL:</label>
        <input type="text" id="fr-api-url" value="${pluginSettings.api_url}">

        <label>API-timeout (sek):</label>
        <input type="number" id="fr-api-timeout" value="${pluginSettings.api_timeout}" min="1" max="120">

        <label>Visa konfidensgrad:</label>
        <input type="checkbox" id="fr-show-confidence" ${pluginSettings.show_confidence ? 'checked' : ''}>

        <label>Minimum konfidens (0–100):</label>
        <input type="number" id="fr-min-confidence" value="${pluginSettings.min_confidence}" min="0" max="100">

        <label>
          <input type="checkbox" id="fr-auto-add" ${pluginSettings.auto_add_performers ? 'checked' : ''}>
          Lägg automatiskt till performers i scenen
        </label>

        <label>
          <input type="checkbox" id="fr-create-new" ${pluginSettings.create_new_performers ? 'checked' : ''}>
          Skapa nya performers för okända ansikten
        </label>

        <hr style="margin:12px 0;border-color:#3a3a3a;">

        <label>Max förslag (topp‑K):</label>
        <input type="number" id="fr-max-suggestions" value="${pluginSettings.max_suggestions}" min="1" max="10">

        <label>Bildkälla (local | stashdb | both):</label>
        <input type="text" id="fr-image-source" value="${pluginSettings.image_source}">

        <label>StashDB endpoint (proxy använder denna):</label>
        <input type="text" id="fr-stashdb-endpoint" value="${pluginSettings.stashdb_endpoint}">

        <div class="fr-sp-actions">
          <button type="button" id="fr-sp-save">Spara</button>
          <button type="button" id="fr-sp-close">Stäng</button>
        </div>
      </div>`;

    const style = document.createElement('style');
    style.textContent = `
      .fr-settings-panel{position:fixed;top:64px;right:16px;width:320px;background:#16181d;color:#e5e7eb;border:1px solid #2a2f39;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.6);z-index:10000}
      .fr-sp-head{font-weight:600;padding:10px 12px;border-bottom:1px solid #2a2f39}
      .fr-sp-body{padding:12px}
      .fr-sp-body label{display:block;margin-top:10px;margin-bottom:6px;font-size:12px;color:#aab0bb}
      .fr-sp-body input[type=text], .fr-sp-body input[type=number]{width:100%;padding:8px;border-radius:8px;border:1px solid #2a2f39;background:#0f1115;color:#e5e7eb}
      .fr-sp-actions{display:flex;gap:8px;margin-top:14px}
      .fr-sp-actions button{background:#2a61ff;color:#fff;border:0;border-radius:10px;padding:8px 12px;cursor:pointer}
      .fr-sp-actions button#fr-sp-close{background:#3a3f4b}`;

    wrap.appendChild(style);
    document.body.appendChild(wrap);
    wrap.querySelector('#fr-sp-close').addEventListener('click', () => wrap.remove());
    wrap.querySelector('#fr-sp-save').addEventListener('click', () => { saveSettingsFromPanel(wrap); wrap.remove(); });
  }
  function saveSettingsFromPanel(root){
    try{
      pluginSettings.api_url = root.querySelector('#fr-api-url').value || pluginSettings.api_url;
      pluginSettings.api_timeout = parseInt(root.querySelector('#fr-api-timeout').value) || pluginSettings.api_timeout;
      pluginSettings.show_confidence = !!root.querySelector('#fr-show-confidence').checked;
      pluginSettings.min_confidence = Math.min(100, Math.max(0, parseInt(root.querySelector('#fr-min-confidence').value) || 0));
      pluginSettings.auto_add_performers = !!root.querySelector('#fr-auto-add').checked;
      pluginSettings.create_new_performers = !!root.querySelector('#fr-create-new').checked;
      pluginSettings.max_suggestions = Math.min(10, Math.max(1, parseInt(root.querySelector('#fr-max-suggestions').value) || 3));
      pluginSettings.image_source = (root.querySelector('#fr-image-source').value || 'both').toLowerCase();
      pluginSettings.stashdb_endpoint = root.querySelector('#fr-stashdb-endpoint').value || 'https://stashdb.org/graphql';
      saveSettings();
      notify('Inställningar sparade');
    }catch(e){ console.error('Kunde inte spara inställningar:', e); notify('Fel vid sparning av inställningar', true); }
  }

  // ---------------- Hjälpare för video/overlay ----------------
  function findVideoElement(){ for (const sel of ['.video-js video','.vjs-tech','video[playsinline]','video']){ const el=document.querySelector(sel); if(el) return el; } return null; }
  function findVideoContainer(){ const video=findVideoElement(); if(!video) return null; let c=video.parentElement; while(c&&c!==document.body){ const cs=getComputedStyle(c); if(cs.position==='relative'||cs.position==='absolute') return c; c=c.parentElement; } return video.parentElement||null; }
  function clearOverlay(){ document.querySelectorAll('.frp-overlay').forEach(n=>n.remove()); }
  function ensureOverlay(){ const cont=findVideoContainer()||document.body; let ov=cont.querySelector('.frp-overlay'); if(ov) return ov; ov=document.createElement('div'); ov.className='frp-overlay'; const cs=getComputedStyle(cont); if(cont===document.body||cs.position==='static'){ Object.assign(ov.style,{position:'fixed',inset:0}); } else { ov.style.position='absolute'; ov.style.inset='0'; } ov.style.pointerEvents='none'; ov.style.zIndex='2147483647'; cont.appendChild(ov); return ov; }

  function makePreviewTooltip(){
  const tip = document.createElement('div');
  tip.className = 'frp-preview';
  Object.assign(tip.style, {
    position: 'fixed',  // läggs på body => ej klippning av containers
    left: '0px',
    top: '0px',
    width: '128px',
    height: '128px',
    borderRadius: '10px',
    overflow: 'hidden',
    border: '1px solid rgba(255,255,255,0.12)',
    background: '#0f1115',
    boxShadow: '0 8px 18px rgba(0,0,0,.35)',
    pointerEvents: 'none',
    zIndex: 2147483647
  });
  const img = document.createElement('img');
  img.alt = 'preview';
  Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
  tip.appendChild(img);
  return { tip, img };
}

  // ---------------- Bild-URL: bytes‑mode via backend ----------------
  function bytesEndpointFor(name){
    const u = new URL(pluginSettings.api_url.replace(/\/$/, ''));
    const qs = new URLSearchParams({
      name,
      source: pluginSettings.image_source,
      stashdb_endpoint: pluginSettings.stashdb_endpoint,
      format: 'bytes' // <-- viktig del: backend returnerar bildbytes
    });
    return `${u.origin}${u.pathname}/resolve_image?${qs.toString()}`;
  }

  async function resolveImageURL(name){
    if (imageCache.has(name)) return imageCache.get(name);
    const url = bytesEndpointFor(name); // direkt URL till bytes‑endpoint
    imageCache.set(name, url);
    return url;
  }

  function attachHoverPreview(rowEl, name){
  let tipRef = null, enterTimer = null;

  function placeTipNear(el, tip){
    const r = el.getBoundingClientRect();
    const pad = 8, tw = 128, th = 128;
    let x = r.right + pad, y = r.top - 4;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (x + tw > vw) x = Math.max(pad, r.left - pad - tw);
    if (y + th > vh) y = Math.max(pad, vh - th - pad);
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
  }

  rowEl.addEventListener('mouseenter', ()=>{
    enterTimer = setTimeout(async ()=>{
      const url = await resolveImageURL(name);
      if (!url || tipRef) return;
      const { tip, img } = makePreviewTooltip();
      img.src = url;
      document.body.appendChild(tip); // viktigt: på <body>
      placeTipNear(rowEl, tip);
      tipRef = tip;
    }, 150);
  });

  rowEl.addEventListener('mousemove', ()=>{
    if (tipRef) placeTipNear(rowEl, tipRef);
  });

  rowEl.addEventListener('mouseleave', ()=>{
    clearTimeout(enterTimer); enterTimer = null;
    if (tipRef){ tipRef.remove(); tipRef = null; }
  });
}


  function renderRecognizeOverlay(items){
    clearOverlay(); const video=findVideoElement(); if(!video){ notify('Ingen video för overlay', true); return; }
    const ov=ensureOverlay(); const r=video.getBoundingClientRect(); const vw=video.clientWidth||r.width; const vh=video.clientHeight||r.height; const iw=video.videoWidth||vw; const ih=video.videoHeight||vh; const sx=vw/iw, sy=vh/ih;

    items.forEach(face=>{
      const {x,y,w,h}=face.box; const left=r.left+x*sx; const top=r.top+y*sy; const width=w*sx; const height=h*sy;
      const box=document.createElement('div'); Object.assign(box.style,{position:'fixed',left:left+'px',top:top+'px',width:width+'px',height:height+'px',border:'2px solid rgba(0,200,255,0.9)',borderRadius:'6px',boxShadow:'0 0 0 1px rgba(0,0,0,0.35), 0 4px 14px rgba(0,0,0,0.4)'});
      const sug=document.createElement('div'); Object.assign(sug.style,{position:'absolute',left:'0px',top:'100%',marginTop:'6px',minWidth:'240px',background:'rgba(18,18,18,0.92)',color:'#f2f2f2',border:'1px solid rgba(255,255,255,0.12)',borderRadius:'10px',overflow:'hidden',backdropFilter:'blur(6px)',pointerEvents:'auto'});
      const minPct=Math.max(0,Math.min(100,pluginSettings.min_confidence));
      const cands=(face.candidates||[]).filter(c=>(c.score*100)>=minPct).slice(0,pluginSettings.max_suggestions||3);
      if (cands.length===0){ const row=document.createElement('div'); Object.assign(row.style,{padding:'8px 10px',borderBottom:'1px solid rgba(255,255,255,0.06)'}); row.textContent='(inga kandidater över tröskeln)'; sug.appendChild(row); }
      else {
        cands.forEach(c=>{ const row=document.createElement('div'); Object.assign(row.style,{display:'flex',alignItems:'center',gap:'10px',padding:'8px 10px',lineHeight:'1.25',borderBottom:'1px solid rgba(255,255,255,0.06)'}); const span=document.createElement('span'); span.textContent=pluginSettings.show_confidence?`${c.name} (${Math.round(c.score*100)}%)`:c.name; Object.assign(span.style,{fontSize:'14px',fontWeight:'600',color:'#f7f7f7',textShadow:'0 1px 1px rgba(0,0,0,0.4)'}); row.appendChild(span); sug.appendChild(row); attachHoverPreview(row,c.name); }); const last=sug.lastElementChild; if(last) last.style.borderBottom='none'; }
      box.appendChild(sug); ov.appendChild(box);
    });
  }

  // ---------------- UI‑knapp ----------------
  function createPluginButton(){ const btn=document.createElement('button'); btn.textContent='Identifiera Ansikten'; btn.className='face-recognition-button'; btn.style.marginRight='50px'; btn.addEventListener('click', performFaceRecognition); btn.addEventListener('contextmenu',e=>{ e.preventDefault(); createSettingsPanel(); }); return btn; }
  function addPluginButton(){ const c=findVideoContainer(); if(c&&c.querySelector('.face-recognition-button'))return; const btn=createPluginButton(); if(c){ c.appendChild(btn);} else{ Object.assign(btn.style,{position:'fixed',top:'12px',right:'60px',zIndex:9999}); document.body.appendChild(btn);} }

  // ---------------- Huvudflöde ----------------
  async function performFaceRecognition(){
    try{
      const video=findVideoElement(); if(!video) return notify('Ingen video hittad', true);
      if(!video.videoWidth||!video.videoHeight) return notify('Video ej redo', true);
      const canvas=document.createElement('canvas'); canvas.width=video.videoWidth; canvas.height=video.videoHeight; const ctx=canvas.getContext('2d'); ctx.drawImage(video,0,0); const blob=await new Promise(res=>canvas.toBlob(res,'image/jpeg',0.92)); if(!blob) return notify('Kunde inte skapa bild',true);
      const fd=new FormData(); fd.append('image', new File([blob],'frame.jpg',{type:'image/jpeg'}));
      const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(), Math.max(3,pluginSettings.api_timeout)*1000);
      const url=`${pluginSettings.api_url.replace(/\/$/,'')}/recognize?top_k=${pluginSettings.max_suggestions||3}`; const resp=await fetch(url,{method:'POST',body:fd,signal:ctrl.signal}); clearTimeout(to); if(!resp.ok) throw new Error(`API-fel ${resp.status}`); const data=await resp.json(); renderRecognizeOverlay(Array.isArray(data)?data:[]); }
    catch(e){ console.error(e); notify('Fel vid ansiktsigenkänning', true); }
  }

  function init(){ loadSettings(); if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', addPluginButton); else addPluginButton(); const mo=new MutationObserver(()=>setTimeout(addPluginButton,600)); mo.observe(document.body,{childList:true,subtree:true}); let tries=0; const iv=setInterval(()=>{ try{addPluginButton();}catch{} if(findVideoElement()||++tries>20) clearInterval(iv); },1000); }
  try{ init(); }catch(e){ console.error('Initfel:',e); }
})();
