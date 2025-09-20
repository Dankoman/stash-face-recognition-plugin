// face-recognition.js — bytes-mode bildhämtning via backend-proxy (CSP-safe)
// + Klick på förslag = lägg till performer i aktuell scen via Stash GraphQL

(function(){
  const LS_KEY = 'face_recognition_plugin_settings';
  const imageCache = new Map(); // name -> { href, objectUrl } | null

  let pluginSettings = {
    api_url: 'http://192.168.0.140:5000',
    api_timeout: 30,
    show_confidence: true,
    min_confidence: 30,
    auto_add_performers: false,
    create_new_performers: false,
    max_suggestions: 3,
    image_source: 'stashdb', // local|stashdb|both (skickas till backend)
    stashdb_endpoint: 'https://stashdb.org/graphql',
    // stashdb_api_key hanteras på backend via env
  };

  function loadSettings(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if(raw) pluginSettings = { ...pluginSettings, ...JSON.parse(raw) };
      pluginSettings.api_url = normalizeApiBaseUrl(pluginSettings.api_url) || pluginSettings.api_url;
    }catch{}
  }
  function saveSettings(){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(pluginSettings)); }catch{}
  }

  function getCachedImageHref(name){
    if(!imageCache.has(name)) return undefined;
    const cached = imageCache.get(name);
    if(cached === null) return null;
    return cached?.href || null;
  }

  function storeImageCache(name, entry){
    const prev = imageCache.get(name);
    if(prev && prev.objectUrl){
      const prevHref = typeof prev.href === 'string' ? prev.href : null;
      if(prevHref && prevHref.startsWith('blob:') && (!entry || entry.href !== prevHref)){
        try{ URL.revokeObjectURL(prevHref); }catch(_){}
      }
    }
    imageCache.set(name, entry ?? null);
  }

  if(!window.__frpPreviewCacheCleanup){
    window.__frpPreviewCacheCleanup = true;
    window.addEventListener('beforeunload', () => {
      imageCache.forEach(entry => {
        if(entry && entry.objectUrl){
          const href = typeof entry.href === 'string' ? entry.href : null;
          if(href && href.startsWith('blob:')){
            try{ URL.revokeObjectURL(href); }catch(_){}
          }
        }
      });
      imageCache.clear();
    });
  }

  function normalizeApiBaseUrl(value){
    const trimmed = (value || '').toString().trim();
    if(!trimmed) return '';

    let candidate = trimmed
      .replace(/\\/g, '/')
      .replace(/\s+/g, '')
      .replace(/\.+$/, '');

    if(/^([a-z][a-z0-9+.-]*:\/)([^/])/i.test(candidate)){
      candidate = candidate.replace(/^([a-z][a-z0-9+.-]*:\/)([^/])/i, '$1/$2');
    }

    if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)){
      candidate = `http://${candidate.replace(/^\/+/,'')}`;
    }

    try{
      const url = new URL(candidate);
      const cleanPath = url.pathname.replace(/\/+$/,'');
      return `${url.origin}${cleanPath === '/' ? '' : cleanPath}`;
    }catch(_){
      return candidate.replace(/\/+$/,'');
    }
  }

  function buildApiUrl(pathname = '', params){
    const normalized = normalizeApiBaseUrl(pluginSettings.api_url) || pluginSettings.api_url;
    if(!normalized) return { href:'', error: new Error('API-URL saknas'), raw:'' };

    let original;
    try{
      original = new URL(normalized);
    }catch(err){
      return { href:'', error: err, raw: normalized };
    }

    const info = {
      href: '',
      raw: normalized,
      error: null,
      upgraded: false,
      originalProtocol: original.protocol,
      attemptedProtocol: original.protocol
    };

    const target = new URL(original.toString());
    if(window.location.protocol === 'https:' && target.protocol === 'http:'){
      target.protocol = 'https:';
      info.upgraded = true;
      info.attemptedProtocol = 'https:';
    }

    const basePath = target.pathname.replace(/\/+$/,'');
    const append = pathname ? `${pathname.startsWith('/') ? '' : '/'}${pathname}` : '';
    target.pathname = `${basePath}${append}` || '/';
    target.search = '';

    if(params && typeof params === 'object'){
      Object.entries(params).forEach(([key, value]) => {
        if(value === undefined || value === null) return;
        target.searchParams.set(key, String(value));
      });
    }

    info.href = target.toString();
    return info;
  }

  function notify(msg, isErr=false){
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position:'fixed', bottom:'16px', right:'16px',
      background: isErr ? '#b91c1c' : '#166534', color:'#fff',
      padding:'10px 12px', borderRadius:'10px', zIndex:10000
    });
    document.body.appendChild(el);
    setTimeout(()=>el.remove(), 2200);
  }

  // ---------------- Stash GraphQL helpers ----------------
  async function stashGraphQL(query, variables){
    const resp = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, variables })
    });
    if(!resp.ok) throw new Error(`GraphQL HTTP ${resp.status}`);
    const data = await resp.json();
    if(data.errors) throw new Error(data.errors.map(e=>e.message).join('; '));
    return data.data;
  }

  function getCurrentSceneId(){
    // matcher /scenes/12345 eller /scenes/12345?... 
    const m = location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  async function getScenePerformerIds(sceneId){
    const q = `
      query($id: ID!){
        findScene(id:$id){ id performers { id } }
      }
    `;
    const d = await stashGraphQL(q, { id: sceneId });
    const arr = (d?.findScene?.performers || []).map(p => parseInt(p.id,10)).filter(n => Number.isFinite(n));
    return Array.from(new Set(arr));
  }

  async function findPerformerByName(name){
    const q = `
      query FindPerformer($name:String!){
        findPerformers(
          performer_filter:{ OR:{
            name:{ value:$name, modifier:EQUALS },
            aliases:{ value:$name, modifier:EQUALS }
          }}
          filter:{ per_page: 1 }
        ){
          performers{ id name }
        }
      }
    `;
    const d = await stashGraphQL(q, { name });
    return d?.findPerformers?.performers?.[0] || null;
  }

  async function createPerformerIfAllowed(name){
    if(!pluginSettings.create_new_performers) return null;
    const q = `
      mutation($input: PerformerCreateInput!){
        performerCreate(input:$input){ id name }
      }
    `;
    try{
      const d = await stashGraphQL(q, { input: { name: (name || '').trim() } });
      return d?.performerCreate || null;
    }catch(e){
      const msg = String(e?.message || e);
      // Om personen redan finns i DB: hämta den och fortsätt utan fel
      if(/already exists/i.test(msg)){
        try{
          const p = await findPerformerByName(name);
          if (p) return p;
        }catch(_){}
      }
      throw e;
    }
  }

  async function addPerformerToSceneByName(name){
    const sceneId = getCurrentSceneId();
    if(!sceneId){ notify('Kunde inte hitta scen-ID', true); return; }

    let perf = await findPerformerByName(name);
    if(!perf){
      perf = await createPerformerIfAllowed(name);
      if(!perf){
        notify(`Hittade ingen performer "${name}"`, true);
        return;
      }
    }

    const existing = await getScenePerformerIds(sceneId);
    const pid = parseInt(perf.id, 10);
    if(existing.includes(pid)){
      notify(`"${perf.name}" finns redan i scenen`);
      return;
    }

    const allIds = Array.from(new Set([...existing, pid]));
    const q = `
      mutation($input: SceneUpdateInput!){
        sceneUpdate(input:$input){ id }
      }
    `;
    await stashGraphQL(q, { input: { id: sceneId, performer_ids: allIds } });
    notify(`La till "${perf.name}" i scenen`);
  }

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

        <label>Max förslag (topp-K):</label>
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
      const prevApiUrl = pluginSettings.api_url;
      pluginSettings.api_url = normalizeApiBaseUrl(root.querySelector('#fr-api-url').value) || prevApiUrl;
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
  function findVideoElement(){
    for (const sel of ['.video-js video','.vjs-tech','video[playsinline]','video']){
      const el = document.querySelector(sel);
      if(el) return el;
    }
    return null;
  }
  function findVideoContainer(){
    const video = findVideoElement(); if(!video) return null;
    let c = video.parentElement;
    while(c && c !== document.body){
      const cs = getComputedStyle(c);
      if(cs.position === 'relative' || cs.position === 'absolute') return c;
      c = c.parentElement;
    }
    return video.parentElement || null;
  }
  function clearOverlay(){ document.querySelectorAll('.frp-overlay').forEach(n=>n.remove()); }
  function ensureOverlay(){
    const cont = findVideoContainer() || document.body;
    let ov = cont.querySelector('.frp-overlay');
    if(ov) return ov;
    ov = document.createElement('div');
    ov.className = 'frp-overlay';
    const cs = getComputedStyle(cont);
    if(cont === document.body || cs.position === 'static'){
      Object.assign(ov.style, { position:'fixed', inset:0 });
    } else {
      ov.style.position = 'absolute';
      ov.style.inset = '0';
    }
    ov.style.pointerEvents = 'none';
    ov.style.zIndex = '2147483647';
    cont.appendChild(ov);
    return ov;
  }

  // ---------------- Tooltip (förhandsbild) ----------------
  function makePreviewTooltip(){
    const tip = document.createElement('div');
    tip.className = 'frp-preview';
    Object.assign(tip.style, {
      position:'fixed', left:'0px', top:'0px',
      borderRadius:'10px', border:'1px solid rgba(255,255,255,0.12)',
      background:'#0f1115', boxShadow:'0 8px 18px rgba(0,0,0,.35)',
      pointerEvents:'none', zIndex:2147483647,
      overflow:'visible',
      maxWidth:'150px',
      maxHeight:'90vh'
    });

    const img = document.createElement('img');
    img.alt = 'preview';
    img.className = 'frp-avatar';
    Object.assign(img.style, {
      display:'block',
      width:'100%',
      height:'auto',
      objectFit:'contain',
      maxWidth:'150px',
      maxHeight:'90vh'
    });
    img.style.setProperty('max-width','150px','important');
    img.style.setProperty('max-height','90vh','important');
    img.style.setProperty('width','100%','important');
    img.style.setProperty('height','auto','important');
    img.style.setProperty('object-fit','contain','important');

    tip.appendChild(img);
    return { tip, img };
  }

  // ---------------- Bild-URL: bytes-mode via backend ----------------
  function bytesEndpointFor(name){
    const info = buildApiUrl('resolve_image', {
      name,
      source: pluginSettings.image_source,
      stashdb_endpoint: pluginSettings.stashdb_endpoint,
      format: 'bytes'
    });
    if(info.error){
      throw info.error;
    }
    return info.href;
  }

  async function resolveImageURL(name, signal){
    const cached = getCachedImageHref(name);
    if(cached !== undefined) return cached;

    let endpoint;
    try{
      endpoint = bytesEndpointFor(name);
    }catch(err){
      console.error('Kunde inte bygga bild-URL:', err);
      storeImageCache(name, null);
      return null;
    }

    try{
      const resp = await fetch(endpoint, { signal });
      if(resp.status === 204){
        storeImageCache(name, null);
        return null;
      }
      if(!resp.ok){
        throw new Error(`HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      if(!blob || !blob.size){
        storeImageCache(name, null);
        return null;
      }
      const objectUrl = URL.createObjectURL(blob);
      storeImageCache(name, { href: objectUrl, objectUrl: true });
      return objectUrl;
    }catch(err){
      if(err?.name === 'AbortError'){
        throw err;
      }
      console.error('Kunde inte hämta preview-bild:', err);
      return null;
    }
  }

  // ---------------- Hover-preview per rad ----------------
  function attachHoverPreview(rowEl, name){
    let tipRef = null;
    let enterTimer = null;
    let pendingCtrl = null;

    function placeTipNear(el, tip){
      const r  = el.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      const pad = 8;
      const vw = window.innerWidth, vh = window.innerHeight;

      let x = r.right + pad;
      let y = r.top - 4;

      if (x + tr.width  > vw) x = Math.max(pad, r.left - pad - tr.width);
      if (y + tr.height > vh) y = Math.max(pad, vh - tr.height - pad);

      tip.style.left = x + 'px';
      tip.style.top  = y + 'px';
    }

    function removeTip(){
      if (tipRef){
        tipRef.remove();
        tipRef = null;
      }
    }

    rowEl.addEventListener('mouseenter', ()=>{
      if(enterTimer) clearTimeout(enterTimer);
      enterTimer = setTimeout(async ()=>{
        if (tipRef) return;
        const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
        pendingCtrl = ctrl;
        let url;
        try{
          url = await resolveImageURL(name, ctrl ? ctrl.signal : undefined);
        }catch(err){
          if(err?.name !== 'AbortError'){
            console.error('Preview-fetch misslyckades:', err);
          }
          if(pendingCtrl === ctrl) pendingCtrl = null;
          return;
        }
        if(pendingCtrl !== ctrl){
          return;
        }
        pendingCtrl = null;
        if (!url || tipRef) return;

        const { tip, img } = makePreviewTooltip();
        tip.dataset.frPreview = name;
        tip.style.maxWidth = '150px';
        tip.style.maxHeight = '90vh';
        img.style.maxWidth = '150px';
        img.style.width = '100%';
        img.style.height = 'auto';
        img.style.objectFit = 'contain';
        tipRef = tip;

        img.onload = () => {
          if(tipRef !== tip) return;
          if(!tip.parentNode) document.body.appendChild(tip);
          placeTipNear(rowEl, tip);
        };
        img.onerror = () => {
          if(url && typeof url === 'string' && url.startsWith('blob:')){
            try{ URL.revokeObjectURL(url); }catch(_){}
            if(getCachedImageHref(name) === url){
              imageCache.delete(name);
            }
          }
          if(tipRef === tip){
            tipRef = null;
          }
          tip.remove();
        };
        img.src = url;
      }, 150);
    });

    rowEl.addEventListener('mousemove', ()=>{ if (tipRef) placeTipNear(rowEl, tipRef); });
    rowEl.addEventListener('mouseleave', ()=>{
      if(enterTimer){ clearTimeout(enterTimer); enterTimer = null; }
      if(pendingCtrl){
        try{ pendingCtrl.abort(); }catch(_){}
        pendingCtrl = null;
      }
      removeTip();
    });
  }

  // ---------------- Overlay-rendering ----------------
  function renderRecognizeOverlay(items){
    clearOverlay();
    const video = findVideoElement();
    if(!video){ notify('Ingen video för overlay', true); return; }
    const ov = ensureOverlay();
    const r = video.getBoundingClientRect();
    const vw = video.clientWidth || r.width;
    const vh = video.clientHeight || r.height;
    const iw = video.videoWidth || vw;
    const ih = video.videoHeight || vh;
    const sx = vw/iw, sy = vh/ih;

    items.forEach(face=>{
      const {x,y,w,h} = face.box;
      const left = r.left + x*sx;
      const top  = r.top  + y*sy;
      const width  = w*sx;
      const height = h*sy;

      const box = document.createElement('div');
      Object.assign(box.style, {
        position:'fixed', left:left+'px', top:top+'px',
        width:width+'px', height:height+'px',
        border:'2px solid rgba(0,200,255,0.9)', borderRadius:'6px',
        boxShadow:'0 0 0 1px rgba(0,0,0,0.35), 0 4px 14px rgba(0,0,0,0.4)'
      });

      const sug = document.createElement('div');
      Object.assign(sug.style, {
        position:'absolute', left:'0px', top:'100%', marginTop:'6px',
        minWidth:'240px', background:'rgba(18,18,18,0.92)', color:'#f2f2f2',
        border:'1px solid rgba(255,255,255,0.12)', borderRadius:'10px',
        overflow:'hidden', backdropFilter:'blur(6px)', pointerEvents:'auto'
      });

      const minPct = Math.max(0, Math.min(100, pluginSettings.min_confidence));
      const cands = (face.candidates||[])
        .filter(c => (c.score*100) >= minPct)
        .slice(0, pluginSettings.max_suggestions || 3);

      if (cands.length === 0){
        const row = document.createElement('div');
        Object.assign(row.style, { padding:'8px 10px', borderBottom:'1px solid rgba(255,255,255,0.06)' });
        row.textContent = '(inga kandidater över tröskeln)';
        sug.appendChild(row);
      } else {
        cands.forEach(c => {
          const row = document.createElement('div');
          Object.assign(row.style, {
            display:'flex', alignItems:'center', gap:'10px',
            padding:'8px 10px', lineHeight:'1.25',
            borderBottom:'1px solid rgba(255,255,255,0.06)',
            cursor:'pointer'
          });
          const span = document.createElement('span');
          span.textContent = pluginSettings.show_confidence ? `${c.name} (${Math.round(c.score*100)}%)` : c.name;
          Object.assign(span.style, { fontSize:'14px', fontWeight:'600', color:'#f7f7f7', textShadow:'0 1px 1px rgba(0,0,0,0.4)' });
          row.appendChild(span);

          // --- NYTT: klick = lägg till i scenen ---
          row.addEventListener('click', async (e)=>{
            e.preventDefault(); e.stopPropagation();
            row.style.opacity = '0.6';
            try{
              await addPerformerToSceneByName(c.name);
            }catch(err){
              console.error(err);
              notify(`Misslyckades: ${err.message||err}`, true);
            }finally{
              row.style.opacity = '';
            }
          });

          sug.appendChild(row);
          attachHoverPreview(row, c.name);
        });
        const last = sug.lastElementChild; if(last) last.style.borderBottom = 'none';
      }

      box.appendChild(sug);
      ov.appendChild(box);
    });
  }

  // ---------------- UI-knapp ----------------
  function createPluginButton(){
    const btn = document.createElement('button');
    btn.textContent = 'Identifiera Ansikten';
    btn.className = 'face-recognition-button';
    btn.style.marginRight = '50px';
    btn.addEventListener('click', performFaceRecognition);
    btn.addEventListener('contextmenu', e => { e.preventDefault(); createSettingsPanel(); });
    return btn;
  }
  function addPluginButton(){
    const c = findVideoContainer();
    if(c && c.querySelector('.face-recognition-button')) return;
    const btn = createPluginButton();
    if(c){ c.appendChild(btn); }
    else {
      Object.assign(btn.style, { position:'fixed', top:'12px', right:'60px', zIndex:9999 });
      document.body.appendChild(btn);
    }
  }

  // ---------------- Huvudflöde ----------------
  async function performFaceRecognition(){
    try{
      const video = findVideoElement(); if(!video) return notify('Ingen video hittad', true);
      if(!video.videoWidth || !video.videoHeight) return notify('Video ej redo', true);

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
      if(!blob) return notify('Kunde inte skapa bild', true);

      const fd = new FormData();
      fd.append('image', new File([blob], 'frame.jpg', { type:'image/jpeg' }));
      const ctrl = new AbortController();

      const timeoutMs = Math.max(3, pluginSettings.api_timeout) * 1000;
      let timeoutHandle = null;
      let apiInfo = null;
      try{
        timeoutHandle = setTimeout(() => ctrl.abort(), timeoutMs);
        apiInfo = buildApiUrl('recognize', { top_k: pluginSettings.max_suggestions || 3 });
        if(apiInfo?.error){
          console.error('Ogiltig API-URL:', apiInfo.error);
          notify('Ogiltig API-URL, uppdatera inställningarna', true);
          return;
        }
        if(apiInfo?.upgraded){
          console.warn(`face-recognition: uppgraderar API-URL till HTTPS (${apiInfo.raw})`);
        }
        const resp = await fetch(apiInfo.href, { method:'POST', body:fd, signal:ctrl.signal });
        if(!resp.ok) throw new Error(`API-fel ${resp.status}`);
        const data = await resp.json();
        renderRecognizeOverlay(Array.isArray(data) ? data : []);
      }catch(err){
        if(err.name === 'AbortError'){
          notify('API-timeout uppnådd', true);
        }else if(apiInfo?.upgraded && window.location.protocol === 'https:'){
          console.error(err);
          notify('Kunde inte kontakta face_extractor via HTTPS. Aktivera HTTPS på API:t eller öppna Stash via HTTP.', true);
        }else{
          console.error(err);
          notify('Fel vid ansiktsigenkänning', true);
        }
      }finally{
        if(timeoutHandle) clearTimeout(timeoutHandle);
      }
    }
    catch(e){
      console.error(e);
      notify('Fel vid ansiktsigenkänning', true);

      const to = setTimeout(() => ctrl.abort(), Math.max(3, pluginSettings.api_timeout) * 1000);
      const apiBase = normalizeApiBaseUrl(pluginSettings.api_url) || pluginSettings.api_url;
      const url = `${apiBase.replace(/[/]$/,'')}/recognize?top_k=${pluginSettings.max_suggestions||3}`;
      const resp = await fetch(url, { method:'POST', body:fd, signal:ctrl.signal });
      clearTimeout(to);
      if(!resp.ok) throw new Error(`API-fel ${resp.status}`);
      const data = await resp.json();
      renderRecognizeOverlay(Array.isArray(data) ? data : []);

    }
  }

  function init(){
    loadSettings();
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addPluginButton);
    else addPluginButton();

    const mo = new MutationObserver(() => setTimeout(addPluginButton, 600));
    mo.observe(document.body, { childList:true, subtree:true });

    let tries = 0;
    const iv = setInterval(() => {
      try{ addPluginButton(); }catch{}
      if(findVideoElement() || ++tries > 20) clearInterval(iv);
    }, 1000);
  }

  try{ init(); }catch(e){ console.error('Initfel:', e); }
})();
