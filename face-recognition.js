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

  function arrayBufferToBase64(buffer){
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for(let i=0;i<bytes.length;i+=chunkSize){
      const slice = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
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

  function normalizeCandidateName(value){
    if(value === undefined || value === null) return '';
    const text = String(value).trim();
    if(!text) return '';
    const unquoted = text.replace(/^"(.*)"$/, '$1');
    return unquoted.replace(/\s+/g, ' ').trim();
  }

  function generateAliasCandidates(name){
    const normalized = normalizeCandidateName(name);
    if(!normalized) return [];
    const variants = new Set();
    const push = val => {
      const norm = normalizeCandidateName(val);
      if(norm) variants.add(norm);
    };
    push(normalized);
    const withoutParens = normalized.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if(withoutParens) push(withoutParens);
    normalized.split(/\s*(?:\/|\||,|;|aka)\s*/i).forEach(push);
    const roman = normalized.replace(/\s+[IVXLCDM]+$/i, '').trim();
    if(roman) push(roman);
    return Array.from(variants).filter(Boolean);
  }

  function uniqueStrings(list){
    const seen = new Set();
    const out = [];
    for(const val of list || []){
      if(!val) continue;
      if(seen.has(val)) continue;
      seen.add(val);
      out.push(val);
    }
    return out;
  }

  function parseIntegerLike(value){
    if(value === undefined || value === null) return undefined;
    if(typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    const text = String(value).trim();
    if(!text) return undefined;
    const digits = text.replace(/[^0-9.]/g, '');
    if(!digits) return undefined;
    const num = parseFloat(digits);
    if(!Number.isFinite(num)) return undefined;
    return Math.round(num);
  }

  const ENUM_OVERRIDES = {
    gender: {
      TRANSGENDER_FEMALE: 'TRANS_FEMALE',
      TRANSGENDER_MALE: 'TRANS_MALE',
      TRANSGENDER: 'TRANS_FEMALE',
      TRANSSEXUAL: 'TRANS_FEMALE',
      'TRANS FEMALE': 'TRANS_FEMALE',
      'TRANS MALE': 'TRANS_MALE',
      'NON BINARY': 'NON_BINARY',
      'NON-BINARY': 'NON_BINARY',
      GENDERQUEER: 'NON_BINARY',
    },
    ethnicity: {
      CAUCASIAN: 'WHITE',
      EUROPEAN: 'WHITE',
      AFRICAN_AMERICAN: 'BLACK',
      AFRICAN: 'BLACK',
      LATINA: 'HISPANIC',
      LATINO: 'HISPANIC',
      HISPANIC: 'HISPANIC',
      MIDDLE_EASTERN: 'MIDDLE_EASTERN',
      MIXED: 'MIXED',
      MULTI: 'MIXED',
      ASIAN: 'ASIAN',
      INDIAN: 'INDIAN',
    },
    hair_color: {
      BRUNETTE: 'BROWN',
      DARK_BROWN: 'BROWN',
      LIGHT_BROWN: 'BROWN',
      DARK_BLONDE: 'BLONDE',
      DIRTY_BLONDE: 'BLONDE',
      AUBURN: 'AUBURN',
      REDHEAD: 'RED',
      GREY: 'GREY',
      GRAY: 'GREY',
    },
    eye_color: {
      HONEY: 'AMBER',
      AMBER: 'AMBER',
      GREY: 'GREY',
      GRAY: 'GREY',
      HAZEL: 'HAZEL',
      GREEN: 'GREEN',
      BLUE: 'BLUE',
      BROWN: 'BROWN',
    },
  };

  let performerSchemaCaps = null;

  async function ensurePerformerSchemaCaps(){
    if(performerSchemaCaps) return performerSchemaCaps;
    const query = `
      query PerformerInputCaps {
        performerInput: __type(name:"PerformerCreateInput") {
          inputFields { name type { kind name ofType { kind name ofType { kind name } } } }
        }
        genderEnum: __type(name:"GenderEnum") { enumValues { name } }
        ethnicityEnum: __type(name:"EthnicityEnum") { enumValues { name } }
        hairEnum: __type(name:"HairColorEnum") { enumValues { name } }
        eyeEnum: __type(name:"EyeColorEnum") { enumValues { name } }
      }
    `;

    const unwrapTypeName = node => {
      if(!node) return undefined;
      if(node.name) return node.name;
      return unwrapTypeName(node.ofType);
    };

    try{
      const data = await stashGraphQL(query, {});
      const rawFields = Array.isArray(data?.performerInput?.inputFields) ? data.performerInput.inputFields : [];
      const inputFields = new Map();
      rawFields.forEach(field => {
        if(!field?.name) return;
        const typeName = unwrapTypeName(field.type) || null;
        inputFields.set(field.name, typeName);
      });
      const enums = {
        gender: new Set((data?.genderEnum?.enumValues || []).map(e => e?.name).filter(Boolean)),
        ethnicity: new Set((data?.ethnicityEnum?.enumValues || []).map(e => e?.name).filter(Boolean)),
        hair_color: new Set((data?.hairEnum?.enumValues || []).map(e => e?.name).filter(Boolean)),
        eye_color: new Set((data?.eyeEnum?.enumValues || []).map(e => e?.name).filter(Boolean)),
      };
      performerSchemaCaps = { inputFields, enums };
      if(!performerSchemaCaps.logged){
        console.debug('PerformerCreateInput fields', Array.from(inputFields.entries()));
        performerSchemaCaps.logged = true;
      }
    }catch(err){
      console.error('Kunde inte introspektera PerformerCreateInput', err);
      performerSchemaCaps = { inputFields: new Map(), enums: { gender: new Set(), ethnicity: new Set(), hair_color: new Set(), eye_color: new Set() } };
    }
    return performerSchemaCaps;
  }

  function mapEnumValue(rawValue, enumName, caps){
    if(!rawValue) return undefined;
    const enums = caps?.enums?.[enumName];
    if(!enums || !enums.size) return undefined;
    const normalized = String(rawValue).trim();
    if(!normalized) return undefined;
    const candidate = normalized.replace(/[^\w]+/g, '_').replace(/_+/g, '_').toUpperCase();
    if(enums.has(candidate)) return candidate;
    const overrides = ENUM_OVERRIDES[enumName] || {};
    const override = overrides[candidate];
    if(Array.isArray(override)){
      for(const val of override){
        if(enums.has(val)) return val;
      }
    }else if(typeof override === 'string' && enums.has(override)){
      return override;
    }
    return undefined;
  }

  function canUseInputField(caps, field){
    if(!caps || !caps.inputFields) return false;
    const inputFields = caps.inputFields;
    if(typeof inputFields.has === 'function') return inputFields.has(field);
    if(typeof inputFields.get === 'function') return inputFields.has(field);
    if(Array.isArray(inputFields)) return inputFields.includes(field);
    return false;
  }

  function getInputFieldType(caps, field){
    if(!caps || !caps.inputFields) return undefined;
    const inputFields = caps.inputFields;
    if(typeof inputFields.get === 'function') return inputFields.get(field);
    return undefined;
  }

  function isInputObjectType(typeName){
    if(typeof typeName !== 'string') return false;
    return /INPUT$/i.test(typeName.trim());
  }
  function isUploadType(typeName){
    if(typeof typeName !== 'string') return false;
    return typeName.trim().toLowerCase() == 'upload';
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
        if(Array.isArray(value)){
          value.forEach(v => {
            if(v === undefined || v === null) return;
            target.searchParams.append(key, String(v));
          });
        }else{
          target.searchParams.set(key, String(value));
        }
      });
    }

    info.href = target.toString();
    return info;
  }

  async function fetchStashdbMetadata(name, aliasCandidates){
    const normalized = normalizeCandidateName(name);
    if(!normalized) return null;
    const params = {
      name: normalized,
      stashdb_endpoint: pluginSettings.stashdb_endpoint || 'https://stashdb.org/graphql'
    };
    if(Array.isArray(aliasCandidates) && aliasCandidates.length){
      const extras = uniqueStrings(aliasCandidates.map(normalizeCandidateName)).filter(val => val && val !== normalized);
      if(extras.length) params.alias = extras;
    }
    const apiInfo = buildApiUrl('stashdb/performer', params);
    if(apiInfo?.error){
      console.error('Ogiltig API-URL för stashdb/performer:', apiInfo.error);
      return null;
    }
    const ctrl = new AbortController();
    const timeoutMs = Math.max(3, pluginSettings.api_timeout || 0) * 1000;
    const handle = setTimeout(() => ctrl.abort(), timeoutMs);
    try{
      const resp = await fetch(apiInfo.href, { method: 'GET', signal: ctrl.signal });
      if(resp.status === 404) return null;
      if(!resp.ok){
        console.warn('stashdb/performer gav fel', resp.status);
        return null;
      }
      const data = await resp.json();
      if(!data || !data.performer) return null;
      return data;
    }catch(err){
      if(err.name !== 'AbortError'){
        console.error('Fel vid hämtning av StashDB-metadata:', err);
      }
      return null;
    }finally{
      clearTimeout(handle);
    }
  }

  async function buildPerformerCreateInput(normalizedName, aliasCandidates){
    const caps = await ensurePerformerSchemaCaps();
    const canUse = field => canUseInputField(caps, field);
    const metadata = await fetchStashdbMetadata(normalizedName, aliasCandidates);
    const input = {};
    if(!metadata){
      return { input, metadata: null, caps, canonicalName: normalizedName, imageStrategy: { mode:'none', url:null } };
    }

    const performer = metadata.performer || {};
    const canonicalName = normalizeCandidateName(performer.name) || normalizedName;
    const primaryNameForAliases = normalizeCandidateName(canonicalName) || normalizedName;

    if(canUse('disambiguation') && performer.disambiguation){
      input.disambiguation = performer.disambiguation;
    }

    const aliasesFromMetadata = Array.isArray(performer.aliases) ? performer.aliases.map(normalizeCandidateName) : [];
    const aliasesFromArgs = Array.isArray(aliasCandidates) ? aliasCandidates.map(normalizeCandidateName) : [];
    const aliasList = uniqueStrings([...aliasesFromMetadata, ...aliasesFromArgs]).filter(alias => alias && alias !== primaryNameForAliases);
    const aliasFieldTypeRaw = getInputFieldType(caps, 'aliases');
    const aliasListFieldTypeRaw = getInputFieldType(caps, 'alias_list');
    const aliasWantsObject = isInputObjectType(aliasFieldTypeRaw);
    const aliasListWantsObject = isInputObjectType(aliasListFieldTypeRaw);
    if(canUse('aliases') && aliasList.length){
      input.aliases = aliasWantsObject ? aliasList : aliasList[0];
    } else if(canUse('alias_list') && aliasList.length){
      input.alias_list = aliasListWantsObject ? aliasList : aliasList[0];
    }

    if(canUse('gender')){
      const genderValue = mapEnumValue(performer.gender, 'gender', caps);
      if(genderValue) input.gender = genderValue;
    }
    if(canUse('ethnicity')){
      const ethnicityValue = mapEnumValue(performer.ethnicity, 'ethnicity', caps);
      if(ethnicityValue) input.ethnicity = ethnicityValue;
    }
    if(canUse('country') && performer.country){
      input.country = performer.country;
    } else if(canUse('country_code') && performer.country){
      input.country_code = performer.country;
    }
    if(canUse('birthdate') && performer.birthdate){
      input.birthdate = performer.birthdate;
    }
    if(canUse('death_date') && (performer.death_date || performer.deathdate)){
      input.death_date = performer.death_date || performer.deathdate;
    }
    if(canUse('hair_color')){
      const hairValue = mapEnumValue(performer.hair_color, 'hair_color', caps);
      if(hairValue) input.hair_color = hairValue;
    }
    if(canUse('eye_color')){
      const eyeValue = mapEnumValue(performer.eye_color, 'eye_color', caps);
      if(eyeValue) input.eye_color = eyeValue;
    }
    if(canUse('measurements') && performer.measurements){
      input.measurements = performer.measurements;
    }

    const heightSource = performer.height_cm ?? performer.height;
    if(canUse('height')){
      const h = parseIntegerLike(heightSource);
      if(typeof h === 'number') input.height = h;
    }else if(canUse('height_cm')){
      const h = parseIntegerLike(heightSource);
      if(typeof h === 'number') input.height_cm = h;
    }
    if(canUse('weight')){
      const w = parseIntegerLike(performer.weight);
      if(typeof w === 'number') input.weight = w;
    }

    if(canUse('urls') || canUse('url')){
      const baseUrls = Array.isArray(performer.urls) ? performer.urls : [];
      const rawUrlEntries = [];
      baseUrls.forEach(entry => {
        if(!entry) return;
        if(typeof entry === 'string'){
          rawUrlEntries.push(entry);
        }else if(typeof entry === 'object'){
          const candidate = entry.url || entry.href || '';
          if(candidate) rawUrlEntries.push(candidate);
        }
      });
      if(metadata.image_url){
        rawUrlEntries.push(metadata.image_url);
      }
      const social = performer.social || {};
      [['instagram','https://instagram.com/'], ['twitter','https://twitter.com/'], ['tiktok','https://www.tiktok.com/@']].forEach(([key, prefix]) => {
        const value = social?.[key];
        if(typeof value !== 'string') return;
        let href = value.trim();
        if(!href) return;
        if(!/^https?:/i.test(href)){
          href = `${prefix}${href.replace(/^@+/, '')}`;
        }
        rawUrlEntries.push(href);
      });
      const seen = new Set();
      const urls = [];
      rawUrlEntries.forEach(entry => {
        if(!entry) return;
        let clean = String(entry).trim();
        if(!clean) return;
        if(!/^https?:/i.test(clean)){
          clean = `https://${clean.replace(/^\/+/, '')}`;
        }
        if(seen.has(clean)) return;
        seen.add(clean);
        urls.push(clean);
      });
      if(urls.length){
        const urlsTypeRaw = getInputFieldType(caps, 'urls');
        const urlTypeRaw = getInputFieldType(caps, 'url');
        const wantsObjectList = isInputObjectType(urlsTypeRaw);
        if(canUse('urls')){
          input.urls = wantsObjectList ? urls.map(url => ({ url })) : urls;
        } else if(canUse('url')) {
          const singleIsObject = isInputObjectType(urlTypeRaw);
          input.url = singleIsObject ? { url: urls[0] } : urls[0];
        }
      }
    }

    if(canUse('stash_ids') || canUse('stash_id')){
      const fallbackEndpoint = metadata.source_endpoint || pluginSettings.stashdb_endpoint || 'https://stashdb.org/graphql';
      const rawStashIds = Array.isArray(performer.stash_ids) ? performer.stash_ids : [];
      const stashIds = [];
      rawStashIds.forEach(entry => {
        if(!entry) return;
        const stashId = entry.stash_id || entry.id;
        if(!stashId) return;
        const endpoint = entry.endpoint || entry.url || fallbackEndpoint;
        stashIds.push({ stash_id: String(stashId), endpoint });
      });
      if(!stashIds.length && performer.id){
        stashIds.push({ stash_id: String(performer.id), endpoint: fallbackEndpoint });
      }
      if(stashIds.length){
        if(canUse('stash_ids')){
          const seen = new Set();
          const uniq = stashIds.filter(item => {
            const key = `${item.endpoint}:${item.stash_id}`;
            if(seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          input.stash_ids = uniq;
        }else if(canUse('stash_id')){
          input.stash_id = stashIds[0]?.stash_id;
          if(canUse('stash_endpoint')) input.stash_endpoint = stashIds[0]?.endpoint;
        }
      }
    }

    const imageCandidates = [];
    if(metadata.image_url) imageCandidates.push(metadata.image_url);
    if(performer.image_url) imageCandidates.push(performer.image_url);
    if(performer.image_path) imageCandidates.push(performer.image_path);
    const primaryImageUrl = imageCandidates.find(url => typeof url === 'string' && url.trim());
    let imageStrategy = { mode:'none', url:null };
    if(primaryImageUrl){
      const cleanUrl = String(primaryImageUrl).trim();
      const imageFieldTypeRaw = getInputFieldType(caps, 'image');
      if(canUse('image_url')){
        input.image_url = cleanUrl;
        imageStrategy = { mode:'url', url: cleanUrl };
      } else if(canUse('image') && imageFieldTypeRaw){
        if(isUploadType(imageFieldTypeRaw)){
          imageStrategy = { mode:'upload', url: cleanUrl };
        } else if(isInputObjectType(imageFieldTypeRaw)){
          input.image = { url: cleanUrl };
          imageStrategy = { mode:'inline', url: cleanUrl };
        } else {
          input.image = cleanUrl;
          imageStrategy = { mode:'inline', url: cleanUrl };
        }
      }
    }

    return { input, metadata, caps, canonicalName, imageStrategy };
  }

  function sanitizeFilename(value){
    const fallback = 'performer';
    if(value === undefined || value === null) return fallback;
    const trimmed = String(value).trim();
    if(!trimmed) return fallback;
    const cleaned = trimmed.replace(/[^0-9a-zA-Z._-]+/g, '_');
    const normalized = cleaned.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return (normalized || fallback).slice(0, 80);
  }

  async function fetchImageBlobViaApi(name){
    const candidate = normalizeCandidateName(name);
    if(!candidate) return null;
    const apiInfo = buildApiUrl('resolve_image', {
      name: candidate,
      source: pluginSettings.image_source,
      stashdb_endpoint: pluginSettings.stashdb_endpoint,
      format: 'bytes'
    });
    if(apiInfo?.error || !apiInfo.href) return null;
    const ctrl = new AbortController();
    const timeoutMs = Math.max(3, pluginSettings.api_timeout || 0) * 1000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try{
      const resp = await fetch(apiInfo.href, { signal: ctrl.signal });
      if(!resp.ok || resp.status === 204) return null;
      const blob = await resp.blob();
      if(!blob || !blob.size) return null;
      return blob;
    }catch(err){
      if(err?.name !== 'AbortError'){
        console.warn('Kunde inte hämta bild via API:', err);
      }
      return null;
    }finally{
      clearTimeout(timer);
    }
  }

  async function fetchImageBlobDirect(url){
    if(!url) return null;
    const href = String(url).trim();
    if(!href) return null;
    const ctrl = new AbortController();
    const timeoutMs = Math.max(3, pluginSettings.api_timeout || 0) * 1000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try{
      const resp = await fetch(href, { signal: ctrl.signal, credentials: 'omit' });
      if(!resp.ok) return null;
      const blob = await resp.blob();
      if(!blob || !blob.size) return null;
      return blob;
    }catch(err){
      if(err?.name !== 'AbortError'){
        console.warn('Kunde inte hämta bild direkt:', err);
      }
      return null;
    }finally{
      clearTimeout(timer);
    }
  }

  async function fetchImageBlobForPerformer(primaryName, fallbackUrl, metadata){
    const rawNames = [];
    if(primaryName) rawNames.push(primaryName);
    const metaName = metadata?.performer?.name;
    if(metaName) rawNames.push(metaName);
    const candidates = uniqueStrings(rawNames.map(normalizeCandidateName).filter(Boolean));
    for(const candidate of candidates){
      const blob = await fetchImageBlobViaApi(candidate);
      if(blob) return blob;
    }

    const rawUrls = [];
    if(fallbackUrl) rawUrls.push(fallbackUrl);
    if(metadata?.image_url) rawUrls.push(metadata.image_url);
    if(metadata?.performer?.image_url) rawUrls.push(metadata.performer.image_url);
    if(metadata?.performer?.image_path) rawUrls.push(metadata.performer.image_path);
    const urlCandidates = uniqueStrings(rawUrls.map(url => url && String(url).trim()).filter(Boolean));
    for(const url of urlCandidates){
      const blob = await fetchImageBlobDirect(url);
      if(blob) return blob;
    }
    return null;
  }

  async function uploadPerformerImageBlob(performerId, blob, preferredName){
    if(!performerId || !blob) return false;
    const mutation = `
      mutation($input: PerformerUpdateInput!){
        performerUpdate(input:$input){ id }
      }
    `;
    const operations = {
      query: mutation,
      variables: {
        input: {
          id: String(performerId),
          image: null
        }
      }
    };
    const map = { '0': ['variables.input.image'] };
    const form = new FormData();
    form.append('operations', JSON.stringify(operations));
    form.append('map', JSON.stringify(map));
    const filename = `${sanitizeFilename(preferredName || performerId)}.jpg`;
    form.append('0', blob, filename);
    const resp = await fetch('/graphql', { method: 'POST', body: form, credentials: 'include' });
    const text = await resp.text();
    let payload = null;
    if(text){
      try{ payload = JSON.parse(text); }catch(_){ payload = null; }
    }
    if(!resp.ok || payload?.errors){
      const message = payload?.errors?.map(e => e?.message).filter(Boolean).join('; ') || `GraphQL HTTP ${resp.status}`;
      const error = new Error(message);
      error.payload = payload ?? text;
      throw error;
    }
    return true;
  }

  async function tryAttachPerformerImage(performerId, canonicalName, imageStrategy, metadata){
    if(!imageStrategy || imageStrategy.mode !== 'upload') return;
    try{
      const blob = await fetchImageBlobForPerformer(canonicalName, imageStrategy.url, metadata);
      if(!blob) return;
      await uploadPerformerImageBlob(performerId, blob, canonicalName);
    }catch(err){
      console.warn('Kunde inte bifoga performer-bild:', err);
    }
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
  async function stashGraphQL(query, variables, init){
    const resp = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, variables }),
      ...(init || {})
    });

    const text = await resp.text();
    let payload = null;
    if(text){
      try{ payload = JSON.parse(text); }catch(_){ payload = null; }
    }

    if(!resp.ok){
      let message = `GraphQL HTTP ${resp.status}`;
      const errors = payload?.errors;
      if(Array.isArray(errors) && errors.length){
        const msg = errors.map(e => e?.message).filter(Boolean).join('; ');
        if(msg) message += `: ${msg}`;
      }else if(text){
        const snippet = text.slice(0, 200).trim();
        if(snippet) message += `: ${snippet}`;
      }
      const error = new Error(message);
      error.status = resp.status;
      error.payload = payload ?? text;
      throw error;
    }

    if(payload?.errors){
      const msg = payload.errors.map(e => e?.message).filter(Boolean).join('; ');
      const error = new Error(msg || 'GraphQL error');
      error.status = resp.status;
      error.payload = payload;
      throw error;
    }

    return payload?.data ?? null;
  }


  async function fetchPerformerById(id){
    if(!id) return null;
    const query = `
      query($id: ID!){
        findPerformer(id:$id){ id name }
      }
    `;
    try{
      const data = await stashGraphQL(query, { id: String(id) });
      return data?.findPerformer || null;
    }catch(err){
      if(err?.status === 422){
        console.warn('fetchPerformerById 422', err.payload || err.message || err);
        return null;
      }
      console.error('fetchPerformerById fel:', err);
      return null;
    }
  }


  function extractNameFromMessage(message){
    if(!message) return null;
    const patterns = [
      /performer with name ['"]([^'"]+)['"] already exists/i,
      /name ['"]([^'"]+)['"]/i
    ];
    for(const pattern of patterns){
      const match = message.match(pattern);
      if(match && match[1]) return match[1].trim();
    }
    return null;
  }


  const performerQueryCache = new Map();
  function buildPerformerQuery(modifier){
    if(performerQueryCache.has(modifier)) return performerQueryCache.get(modifier);
    const query = `
      query($name:String!){
        findPerformers(
          performer_filter:{
            name:{ value:$name, modifier:${modifier} }
          }
          filter:{ per_page: 25 }
        ){
          performers{ id name }
        }
      }
    `;
    performerQueryCache.set(modifier, query);
    return query;
  }

  async function resolveExistingPerformer(name, aliasCandidates, duplicateDetails, duplicateMessage){
    const idCandidates = [];
    const idKeys = ["id","existingId","duplicateId","performer_id","performerId"];
    if(duplicateDetails){
      for (const key of idKeys){
        const value = duplicateDetails[key];
        if(value !== undefined && value !== null && value !== ""){
          idCandidates.push(String(value));
        }
      }
    }
    for (const ident of idCandidates){
      const performer = await fetchPerformerById(ident);
      if(performer) return performer;
    }
    const searchTerms = new Set();
    if(name) searchTerms.add(name);
    const normalizedName = normalizeCandidateName(name);
    if(normalizedName) searchTerms.add(normalizedName);
    if(Array.isArray(aliasCandidates)){
      for (const alias of aliasCandidates){
        if(alias) searchTerms.add(alias);
        const normalizedAlias = normalizeCandidateName(alias);
        if(normalizedAlias) searchTerms.add(normalizedAlias);
      }
    }
    const extracted = extractNameFromMessage(duplicateMessage);
    if(extracted) searchTerms.add(extracted);
    const normalizedExtracted = normalizeCandidateName(extracted);
    if(normalizedExtracted) searchTerms.add(normalizedExtracted);
    for (const term of searchTerms){
      if(!term) continue;
      const performer = await findPerformerByName(term);
      if(performer) return performer;
    }
    console.warn('resolveExistingPerformer miss', { name, searchTerms: Array.from(searchTerms), duplicateDetails, duplicateMessage });
    return null;
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
    const normalized = normalizeCandidateName(name);
    if(!normalized) return null;

    const variants = new Set(generateAliasCandidates(name));
    variants.add(name);
    variants.add(normalized);

    const modifiers = ['EQUALS', 'ILIKE', 'CONTAINS'];

    for(const modifier of modifiers){
      const query = buildPerformerQuery(modifier);
      for(const variant of variants){
        const term = normalizeCandidateName(variant);
        if(!term) continue;
        try{
          const data = await stashGraphQL(query, { name: variant });
          const performers = data?.findPerformers?.performers || [];
          if(!performers.length) continue;
          const target = modifier === 'EQUALS' ? term.toLowerCase() : null;
          if(target){
            const match = performers.find(p => normalizeCandidateName(p.name).toLowerCase() === target);
            if(match) return match;
          }
          return performers[0];
        }catch(err){
          if(err?.status === 422){
            continue;
          }
          console.error('findPerformerByName fel:', err.payload || err.message || err);
        }
      }
    }

    return null;
  }
  async function createPerformerIfAllowed(name, aliasCandidates){
    if(!pluginSettings.create_new_performers) return null;
    const normalized = normalizeCandidateName(name);
    if(!normalized) return null;

    let caps = await ensurePerformerSchemaCaps();
    let extraInput = {};
    let canonicalName = normalized;
    let metadataForCreate = null;
    let imageStrategy = { mode:'none', url:null };
    try{
      const result = await buildPerformerCreateInput(normalized, aliasCandidates);
      extraInput = result.input || {};
      caps = result.caps || caps;
      if(result?.canonicalName){
        const candidateName = normalizeCandidateName(result.canonicalName);
        if(candidateName) canonicalName = candidateName;
      }
      metadataForCreate = result.metadata || null;
      if(result.imageStrategy) imageStrategy = result.imageStrategy;
    }catch(err){
      console.error('Kunde inte bygga performerinput från StashDB-data:', err);
      extraInput = {};
    }

    const combinedAliasCandidates = Array.isArray(aliasCandidates) ? [...aliasCandidates] : [];
    if(name && !combinedAliasCandidates.includes(name)) combinedAliasCandidates.push(name);
    if(canonicalName && !combinedAliasCandidates.includes(canonicalName)) combinedAliasCandidates.push(canonicalName);

    const canUse = field => canUseInputField(caps, field);
    if(!extraInput.aliases && !extraInput.alias_list && combinedAliasCandidates.length){
      const aliasList = uniqueStrings(combinedAliasCandidates.map(normalizeCandidateName)).filter(alias => alias && alias !== canonicalName);
      if(aliasList.length){
        const aliasFieldTypeRaw = getInputFieldType(caps, 'aliases');
        const aliasListFieldTypeRaw = getInputFieldType(caps, 'alias_list');
        const aliasWantsObject = isInputObjectType(aliasFieldTypeRaw);
        const aliasListWantsObject = isInputObjectType(aliasListFieldTypeRaw);
        if(canUse('aliases')) extraInput.aliases = aliasWantsObject ? aliasList : aliasList[0];
        else if(canUse('alias_list')) extraInput.alias_list = aliasListWantsObject ? aliasList : aliasList[0];
      }
    }

    const mutation = `
      mutation($input: PerformerCreateInput!){
        performerCreate(input:$input){ id name }
      }
    `;

    const attempts = [];
    const baseInput = { ...extraInput, name: canonicalName };
    attempts.push(baseInput);
    if(Object.keys(extraInput || {}).length){
      attempts.push({ name: canonicalName });
    }

    let lastError = null;
    for(let idx = 0; idx < attempts.length; idx += 1){
      const input = attempts[idx];
      try{
        const data = await stashGraphQL(mutation, { input });
        const created = data?.performerCreate || null;
        if(created){
          await tryAttachPerformerImage(created.id, canonicalName, imageStrategy, metadataForCreate);
          return created;
        }
      }catch(err){
        lastError = err;
        const msg = String(err?.message || '');
        if(/already exists/i.test(msg)){
          const payloadErr = err?.payload?.errors?.[0] || null;
          const duplicateDetails = payloadErr?.extensions || {};
          const existing = await resolveExistingPerformer(name, combinedAliasCandidates, duplicateDetails, payloadErr?.message || err?.message);
          if(existing) return existing;
          continue;
        }
        if(err?.status === 422){
          console.warn('PerformerCreate 422', err.payload || err.message || err);
          if(idx < attempts.length - 1){
            console.warn('PerformerCreate misslyckades med metadata, försöker igen med minimal input');
            continue;
          }
        }
        throw err;
      }
    }

    try{
      const existingCanonical = await findPerformerByName(canonicalName);
      if(existingCanonical) return existingCanonical;
      if(canonicalName !== normalized){
        const existingNormalized = await findPerformerByName(normalized);
        if(existingNormalized) return existingNormalized;
      }
    }catch(err){
      console.error('Misslyckades att hämta performer efter misslyckad skapning:', err);
    }

    if(lastError){
      const messages = [];
      if(lastError?.message) messages.push(String(lastError.message));
      const payloadErr = lastError?.payload?.errors?.[0] || null;
      const payloadMsg = payloadErr?.message;
      if(payloadMsg) messages.push(String(payloadMsg));
      const combined = messages.join(' - ');
      if(/already exists/i.test(combined)){
        const duplicateDetails = payloadErr?.extensions || {};
        const existing = await resolveExistingPerformer(name, combinedAliasCandidates, duplicateDetails, payloadErr?.message || lastError?.message);
        if(existing) return existing;
      }
      if(lastError?.payload) console.warn('PerformerCreate sista felpayload', lastError.payload);
      throw lastError;
    }
    return null;
  }


  async function addPerformerToSceneByName(name){
    const sceneId = getCurrentSceneId();
    if(!sceneId){ notify('Kunde inte hitta scen-ID', true); return; }

    const aliasCandidates = generateAliasCandidates(name);
    let perf = await findPerformerByName(name);
    if(!perf){
      try{
        perf = await createPerformerIfAllowed(name, aliasCandidates);
      }catch(err){
        const messages = [];
        if(err?.message) messages.push(String(err.message));
        const payloadErr = err?.payload?.errors?.[0] || null;
        const payloadMsg = payloadErr?.message;
        if(payloadMsg) messages.push(String(payloadMsg));
        const combined = messages.join(' - ');
        if(/already exists/i.test(combined)){
          const duplicateDetails = payloadErr?.extensions || {};
          perf = await resolveExistingPerformer(name, aliasCandidates, duplicateDetails, payloadMsg || err?.message);
        }
        if(!perf) throw err;
      }
      if(!perf){
        notify(`Hittade ingen performer "${normalizeCandidateName(name) || name}"`, true);
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
      <div class="fr-sp-head">Face Recognition - Inställningar</div>
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
  function findInfoPanelContainer(){
    const hintSelectors = [
      '[data-testid="scene-details-panel"]',
      '.scene-details-panel',
      '.scene-tabs .scene-details',
      '.scene-tabs .scene-info',
      '.SceneDetails',
      '.SceneInfoPanel'
    ];
    for(const sel of hintSelectors){
      const el = document.querySelector(sel);
      if(el) return el;
    }

    const videoHost = findVideoContainer();
    if(!videoHost) return null;
    const videoRect = videoHost.getBoundingClientRect ? videoHost.getBoundingClientRect() : null;
    let parent = videoHost.parentElement;

    while(parent && parent !== document.body){
      let style;
      try{ style = getComputedStyle(parent); }catch(_){ style = null; }
      const isLayout = !!style && (style.display === 'flex' || style.display === 'grid');
      if(isLayout){
        const children = Array.from(parent.children);
        const idx = children.findIndex(child => child === videoHost || child.contains(videoHost));
        if(idx > -1){
          for(let i = idx - 1; i >= 0; i--){
            const sibling = children[i];
            if(!sibling || sibling === videoHost) continue;
            if(sibling.contains(videoHost)) continue;
            if(sibling.querySelector('video')) continue;
            if(videoRect && sibling.getBoundingClientRect){
              const rect = sibling.getBoundingClientRect();
              if(rect.width === 0 && rect.height === 0) continue;
              if(rect.right > (videoRect.left + 20)) continue;
            }
            const text = (sibling.textContent || '').trim();
            if(text.length < 20 && !sibling.querySelector('[data-testid], [data-scene-id], .tag-chip, table, .MuiChip-root, .key-value-row')) continue;
            return sibling;
          }
        }
      }
      parent = parent.parentElement;
    }

    return null;
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
      const buffer = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const contentType = resp.headers.get('Content-Type') || 'image/jpeg';
      const dataUrl = `data:${contentType};base64,${base64}`;
      storeImageCache(name, { href: dataUrl, objectUrl: false });
      return dataUrl;
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
      const pad = 12;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let x = r.right + pad;
      let y = r.top + (r.height - tr.height) / 2;
      const minTop = pad;
      const maxTop = Math.max(pad, vh - tr.height - pad);

      if (y < minTop) y = minTop;
      if (y > maxTop) y = maxTop;

      if (x + tr.width + pad > vw){
        x = r.left - tr.width - pad;
        if (x < pad){
          x = Math.max(pad, Math.min(vw - tr.width - pad, r.left + pad));
        }
      }

      x = Math.max(pad, Math.min(vw - tr.width - pad, x));
      if (x + tr.width > vw - pad){
        x = vw - tr.width - pad;
      }

      tip.style.left = x + 'px';
      tip.style.top  = Math.max(minTop, Math.min(maxTop, y)) + 'px';
    }

    function ensureTipVisible(tip){
      if(!tip) return;
      const rect = tip.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;
      let left = rect.left;
      let top = rect.top;
      if(rect.left < pad) left = pad;
      if(rect.right > vw - pad) left = Math.max(pad, vw - rect.width - pad);
      if(rect.top < pad) top = pad;
      if(rect.bottom > vh - pad) top = Math.max(pad, vh - rect.height - pad);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
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
        tip.style.maxWidth = '120px';
        tip.style.maxHeight = '80vh';
        img.style.maxWidth = '120px';
        img.style.width = '100%';
        img.style.height = 'auto';
        img.style.objectFit = 'contain';
        tipRef = tip;

        img.onload = () => {
          if(tipRef !== tip) return;
          if(!tip.parentNode) document.body.appendChild(tip);
          placeTipNear(rowEl, tip);
          ensureTipVisible(tip);
        };
        img.onerror = () => {
          if(getCachedImageHref(name) === url){
            imageCache.delete(name);
          }
          if(tipRef === tip){
            tipRef = null;
          }
          tip.remove();
        };
        if(!tip.parentNode) document.body.appendChild(tip);
        img.src = url;
      }, 150);
    });

    rowEl.addEventListener('mousemove', () => {
      if(!tipRef) return;
      placeTipNear(rowEl, tipRef);
      ensureTipVisible(tipRef);
    });

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
    btn.type = 'button';
    btn.className = 'frp-fab';
    btn.innerHTML = `<span class="frp-fab-icon" aria-hidden="true">👁</span><span class="frp-fab-text">Identifiera</span>`;
    btn.title = 'Identifiera ansikten (vänsterklick) — Inställningar (högerklick)';
    btn.setAttribute('aria-label', 'Identifiera ansikten');
    btn.addEventListener('click', performFaceRecognition);
    btn.addEventListener('contextmenu', e => { e.preventDefault(); createSettingsPanel(); });
    return btn;
  }
  function resetFabAnchors(){
    document.querySelectorAll('.frp-fab-anchor').forEach(node => {
      if(!node.querySelector('.frp-fab')) node.classList.remove('frp-fab-anchor');
    });
  }
  function ensurePanelPlacement(btn, panelHost){
    btn.classList.add('frp-fab--panel');
    btn.classList.remove('frp-fab--floating', 'frp-fab--global');

    let wrap = btn.closest('.frp-fab-wrapper');
    if(!wrap){
      wrap = document.createElement('div');
      wrap.className = 'frp-fab-wrapper frp-fab-wrapper--panel';
      const parent = btn.parentElement;
      if(parent){
        parent.insertBefore(wrap, btn);
      }
      wrap.appendChild(btn);
    } else {
      wrap.classList.add('frp-fab-wrapper--panel');
    }

    if(!panelHost.contains(wrap)){
      const insertBefore = panelHost.firstElementChild;
      if(insertBefore){
        panelHost.insertBefore(wrap, insertBefore);
      } else {
        panelHost.appendChild(wrap);
      }
    }
  }
  function ensureFloatingPlacement(btn, host){
    btn.classList.add('frp-fab--floating');
    btn.classList.remove('frp-fab--panel');

    const wrap = btn.closest('.frp-fab-wrapper');
    if(wrap){
      wrap.replaceWith(btn);
    }

    if(btn.parentElement !== host){
      host.appendChild(btn);
    }

    if(host === document.body){
      btn.classList.add('frp-fab--global');
    } else {
      btn.classList.remove('frp-fab--global');
      const cs = window.getComputedStyle(host);
      if(cs.position === 'static'){
        host.classList.add('frp-fab-anchor');
      }
    }
  }
  function addPluginButton(){
    const panelHost = findInfoPanelContainer();
    const fallbackHost = findVideoContainer() || document.body;
    const host = panelHost || fallbackHost;
    if(!host) return;

    let btn = document.querySelector('.frp-fab');
    if(btn){
      if(panelHost && panelHost.contains(btn)){
        ensurePanelPlacement(btn, panelHost);
        return;
      }
      if(!panelHost && host.contains(btn) && btn.classList.contains('frp-fab--floating')){
        ensureFloatingPlacement(btn, host);
        return;
      }
      const wrap = btn.closest('.frp-fab-wrapper');
      if(wrap){
        wrap.remove();
      } else {
        btn.remove();
      }
    } else {
      btn = createPluginButton();
    }

    resetFabAnchors();

    if(panelHost){
      ensurePanelPlacement(btn, panelHost);
    } else {
      ensureFloatingPlacement(btn, host);
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
