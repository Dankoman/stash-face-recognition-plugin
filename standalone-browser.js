(function(root) {
  'use strict';
  let worker=null, workerURL=null, sequence=0;
  const pending=new Map();
  function reset(reason) {
    if(worker) worker.terminate(); worker=null;
    if(workerURL) URL.revokeObjectURL(workerURL); workerURL=null;
    for(const request of pending.values()) { clearTimeout(request.timer); request.reject(reason); }
    pending.clear();
  }
  function request(pluginId,type,payload={},timeout=180000) {
    if(!pluginId) return Promise.reject(new Error('Pluginets ID är inte laddat. Ladda om Stash.'));
    if(!worker) {
      const base=new URL(`/plugin/${encodeURIComponent(pluginId)}/assets/face/`,root.location.href).href;
      // Stash permits blob workers; its plugin CSP format cannot add worker-src.
      const bootstrap=`self.FaceRecognitionAssetBase=${JSON.stringify(base)};importScripts(${JSON.stringify(base+'recognition-worker.js')});`;
      workerURL=URL.createObjectURL(new Blob([bootstrap],{type:'text/javascript'}));
      worker=new Worker(workerURL);
      worker.onmessage=({data})=>{
        if(data.status) { console.info('[Face Recognition]',data.status); return; }
        const entry=pending.get(data.id); if(!entry) return;
        pending.delete(data.id); clearTimeout(entry.timer);
        if(data.error) entry.reject(new Error(data.error)); else entry.resolve({result:data.result,backend:data.backend});
      };
      worker.onerror=()=>reset(new Error('Analysmotorn kunde inte startas. Kontrollera pluginfilerna och webbläsarens CSP.'));
      worker.onmessageerror=()=>reset(new Error('Analysmotorn returnerade oläsbara data'));
    }
    return new Promise((resolve,reject)=>{
      const id=++sequence;
      const timer=setTimeout(()=>reset(new Error('Analysen tog för lång tid. Motorn har återställts.')),timeout);
      pending.set(id,{resolve,reject,timer});
      try { worker.postMessage({id,type,...payload},payload.bitmap?[payload.bitmap]:[]); }
      catch(error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  const sourceNames={stashdb:'stashdb',tpdb:'theporndb',pmvstash:'pmvstash',fansdb:'fansdb'};
  const clean=value=>String(value||'').trim().toLowerCase();
  function normalizeMetadata(performer,source,matched) {
    const aliases=String(performer.aliases||'').split(',').map(s=>s.trim()).filter(Boolean);
    const image=(performer.images||[])[0] || performer.image || null;
    return {source_provider:source.name,source_endpoint:source.endpoint||'',matched,image_url:image,performer:{
      ...performer,id:source.endpoint?performer.remote_site_id:undefined,aliases,
      breast_type:performer.fake_tits,
      career_start_year:performer.career_start,career_end_year:performer.career_end,
      tattoos:performer.tattoos?[{description:performer.tattoos}]:[],
      piercings:performer.piercings?[{description:performer.piercings}]:[],
      stash_ids:source.endpoint&&performer.remote_site_id?[{endpoint:source.endpoint,stash_id:performer.remote_site_id}]:[],
    }};
  }
  function metadataClient(gql) {
    let discovery;
    const cache=new Map();
    async function sources() {
      if(!discovery) discovery=gql(`query {
        configuration { general { stashBoxes { endpoint name } } }
        __type(name:"ScrapedPerformer") { fields { name } }
      }`,{}).then(data=>{
        const supported=new Set(data.__type.fields.map(f=>f.name));
        const fields=['name','disambiguation','gender','urls','birthdate','ethnicity','country','eye_color','height','measurements','fake_tits','career_start','career_end','tattoos','piercings','aliases','images','image','details','death_date','hair_color','weight','remote_site_id'].filter(f=>supported.has(f)).join(' ');
        const boxes=(data.configuration.general.stashBoxes||[]).map(b=>({name:b.name||b.endpoint,endpoint:b.endpoint,source:{stash_box_endpoint:b.endpoint}}));
        return {sources:boxes,fields};
      }).catch(error=>{discovery=null;throw error;});
      return discovery;
    }
    async function lookup(name,aliases=[],settings={},signal,identity={}) {
      const key=JSON.stringify([name,aliases,settings.metadata_source,settings.stashdb_endpoint,identity.stash_ids||[]]);
      if(cache.has(key)) return cache.get(key);
      const config=await sources();
      if(!config.sources.length) throw new Error('Konfigurera en metadatakälla under Stash → Settings → Metadata Providers → Stash-Box Endpoints.');
      const preferred=sourceNames[settings.metadata_source]||'stashdb';
      const linkedEndpoints=new Set((identity.stash_ids||[]).map(p=>String(p.endpoint||'').replace(/\/+$/,'')));
      const available=linkedEndpoints.size
        ? config.sources.filter(source=>linkedEndpoints.has(String(source.endpoint||'').replace(/\/+$/,'')))
        : config.sources;
      const ordered=[...available].sort((a,b)=>{
        const priority=s=>clean(s.name+' '+(s.endpoint||'')).includes(preferred)?0:s.endpoint===settings.stashdb_endpoint?1:2;
        return priority(a)-priority(b);
      });
      const terms=[...new Set([name,...aliases].filter(Boolean))], targets=new Set(terms.map(clean)), errors=[];
      for(const source of ordered) {
        for(const term of terms) {
          if(signal?.aborted) throw new DOMException('Avbruten','AbortError');
          try {
            const data=await gql(`query($source:ScraperSourceInput!,$input:ScrapeSinglePerformerInput!){scrapeSinglePerformer(source:$source,input:$input){${config.fields}}}`,{source:source.source,input:{query:term}},{signal});
            const expectedIds=new Set((identity.stash_ids||[])
              .filter(p=>String(p.endpoint||'').replace(/\/+$/,'')===String(source.endpoint||'').replace(/\/+$/,''))
              .map(p=>p.stash_id));
            const rows=data.scrapeSinglePerformer||[];
            // A saved external ID is authoritative even if names or aliases changed.
            const candidates=expectedIds.size
              ? rows.filter(p=>expectedIds.has(p.remote_site_id))
              : rows.filter(p=>[p.name,...String(p.aliases||'').split(',')].some(n=>targets.has(clean(n))));
            const seen=new Set();
            const matches=candidates.filter(p=>{
              if(!p.remote_site_id) return true;
              if(seen.has(p.remote_site_id)) return false;
              seen.add(p.remote_site_id); return true;
            });
            if(matches.length>1) { const error=new Error(`Flera exakta träffar hos ${source.name}; identiteten är tvetydig`); error.ambiguous=true; throw error; }
            if(matches.length===1) {
              const result=normalizeMetadata(matches[0],source,term);
              cache.set(key,result); if(cache.size>64) cache.delete(cache.keys().next().value);
              return result;
            }
          } catch(error) {
            if(error.name==='AbortError' || error.ambiguous) throw error;
            errors.push(`${source.name}: ${error.message}`); break;
          }
        }
      }
      if(errors.length) throw new Error(errors.join('; '));
      return null;
    }
    async function image(name,settings={},signal) {
      if(settings.image_source!=='stashdb') {
        const data=await gql(`query($filter:FindFilterType!){findPerformers(filter:$filter){performers{name alias_list image_path}}}`,{filter:{q:name,per_page:100}},{signal});
        const p=(data.findPerformers?.performers||[]).find(p=>[p.name,...(p.alias_list||[])].some(n=>clean(n)===clean(name)));
        if(p?.image_path && !/default|placeholder/i.test(p.image_path)) return p.image_path;
        if(settings.image_source==='local') return null;
      }
      const metadata=await lookup(name,[],settings,signal);
      return metadata?.image_url||null;
    }
    return {lookup,image,clear(){cache.clear();discovery=null;}};
  }
  root.FaceRecognitionStandalone={
    async recognize(pluginId,blob,topK,timeout,backend='auto') {
      const bitmap=await createImageBitmap(blob);
      try { return (await request(pluginId,'recognize',{bitmap,topK,backend},timeout)).result; }
      catch(error) { bitmap.close(); throw error; }
    },
    async health(pluginId,backend='auto') { const response=await request(pluginId,'health',{backend}); return {...response.result,backend:response.backend}; },
    reset:()=>reset(new Error('Inställningarna ändrades. Försök igen.')),
    metadataClient,normalizeMetadata,
  };
})(globalThis);
