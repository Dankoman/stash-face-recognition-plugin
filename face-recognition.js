// Face Recognition 3 — local browser inference and native Stash metadata
// + Klick på förslag = lägg till performer i aktuell scen via Stash GraphQL

(function () {
  const LEGACY_LS_KEY = 'face_recognition_plugin_settings';
  const imageCache = new Map(); // name -> { href, objectUrl } | null

  const STASH_PLUGIN_NAME = 'Face Recognition Plugin';
  let pluginId = null; // Stash internal plugin ID, resolved at runtime

  const DEFAULT_SETTINGS = Object.freeze({
    compute_backend: 'auto',
    api_timeout: 180,
    show_confidence: true,
    min_confidence: 20,
    auto_add_performers: false,
    create_new_performers: false,
    max_suggestions: 3,
    image_source: 'both', // local|stashdb|both (skickas till backend)
    stashdb_endpoint: 'https://stashdb.org/graphql',
    metadata_source: 'stashdb', // all|stashdb|tpdb|pmvstash|fansdb
  });
  let pluginSettings = { ...DEFAULT_SETTINGS };

  let overlayClearTimer = null;
  const previewDisposers = new Set();
  let recognitionInFlight = false;

  function parseBooleanSetting(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (!normalized) return undefined;
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return undefined;
  }

  function coerceSettingValue(key, value) {
    if (value === undefined || value === null) return undefined;
    switch (key) {
      case 'api_timeout':
      case 'min_confidence':
      case 'max_suggestions': {
        const num = parseInt(value, 10);
        if (!Number.isFinite(num)) return undefined;
        const bounds = {api_timeout:[30,600], min_confidence:[0,100], max_suggestions:[1,10]}[key];
        return Math.max(bounds[0], Math.min(bounds[1], num));
      }
      case 'compute_backend':
        return ['auto', 'cpu'].includes(value) ? value : undefined;
      case 'stashdb_endpoint': {
        const text = String(value).trim();
        return text ? text : undefined;
      }
      case 'metadata_source': {
        const text = String(value).trim().toLowerCase();
        const normalized = text === 'alla' ? 'all' : text;
        return ['all', 'stashdb', 'tpdb', 'pmvstash', 'fansdb'].includes(normalized) ? normalized : undefined;
      }
      case 'image_source': {
        const text = String(value).trim().toLowerCase();
        return text ? text : undefined;
      }
      case 'stashdb_api_key':
      case 'tpdb_api_key':
      case 'pmvstash_api_key':
      case 'fansdb_api_key':
        return undefined; // Stash handles credentials; the plugin never reads them.
      case 'show_confidence':
      case 'auto_add_performers':
      case 'create_new_performers':
        return parseBooleanSetting(value);
      default:
        return undefined;
    }
  }

  async function mergePluginSettingsFromBackend() {
    try {
      // plugins.settings describes the controls; saved values live in configuration.plugins.
      const query = `
        query {
          plugins {
            id
            name
          }
          configuration {
            plugins
          }
        }
      `;
      const data = await stashGraphQL(query, {});
      const allPlugins = data?.plugins;
      if (!Array.isArray(allPlugins)) return;
      const myPlugin = allPlugins.find(p => p.name === STASH_PLUGIN_NAME || p.id === 'face-recognition');
      if (!myPlugin) return;
      // Store plugin ID for write-back via configurePlugin
      if (myPlugin.id) pluginId = myPlugin.id;
      const rawSettings = data?.configuration?.plugins?.[myPlugin.id];
      const merged = {};
      if (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
        for (const [key, value] of Object.entries(rawSettings)) {
          const coerced = coerceSettingValue(key, value);
          if (coerced === undefined) continue;
          merged[key] = coerced;
        }
      }
      pluginSettings = { ...DEFAULT_SETTINGS, ...merged };
      // The previous service timeout did not include browser model loading.
      if (rawSettings && !rawSettings.compute_backend) pluginSettings.api_timeout = DEFAULT_SETTINGS.api_timeout;
      // Only remove the legacy cache after the authoritative settings loaded successfully.
      try { localStorage.removeItem(LEGACY_LS_KEY); } catch { }
    } catch (err) {
      console.warn('Kunde inte läsa plugin-inställningar:', err);
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
  }

  function getCachedImageHref(name) {
    if (!imageCache.has(name)) return undefined;
    const cached = imageCache.get(name);
    if (cached === null) return null;
    return cached?.href || null;
  }

  function storeImageCache(name, entry) {
    const prev = imageCache.get(name);
    if (prev && prev.objectUrl) {
      const prevHref = typeof prev.href === 'string' ? prev.href : null;
      if (prevHref && prevHref.startsWith('blob:') && (!entry || entry.href !== prevHref)) {
        try { URL.revokeObjectURL(prevHref); } catch (_) { }
      }
    }
    imageCache.delete(name);
    imageCache.set(name, entry ?? null);
    while (imageCache.size > 64) {
      const oldest = imageCache.keys().next().value;
      const old = imageCache.get(oldest);
      if (old?.objectUrl && old.href?.startsWith('blob:')) URL.revokeObjectURL(old.href);
      imageCache.delete(oldest);
    }
  }

  function clearImageCache() {
    for (const entry of imageCache.values()) {
      if (entry?.objectUrl && entry.href?.startsWith('blob:')) URL.revokeObjectURL(entry.href);
    }
    imageCache.clear();
  }
  window.addEventListener('beforeunload', clearImageCache, { once: true });

  function normalizeCandidateName(value) {
    if (value === undefined || value === null) return '';
    const text = String(value).trim();
    if (!text) return '';
    const unquoted = text.replace(/^"(.*)"$/, '$1');
    return unquoted.replace(/\s+/g, ' ').trim();
  }

  function generateAliasCandidates(name) {
    const normalized = normalizeCandidateName(name);
    if (!normalized) return [];
    const variants = new Set();
    const push = val => {
      const norm = normalizeCandidateName(val);
      if (norm) variants.add(norm);
    };
    push(normalized);
    const withoutParens = normalized.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (withoutParens) push(withoutParens);
    normalized.split(/\s*(?:\/|\||,|;|aka)\s*/i).forEach(push);
    const roman = normalized.replace(/\s+[IVXLCDM]+$/i, '').trim();
    if (roman) push(roman);
    return Array.from(variants).filter(Boolean);
  }

  function uniqueStrings(list) {
    const seen = new Set();
    const out = [];
    for (const val of list || []) {
      if (!val) continue;
      if (seen.has(val)) continue;
      seen.add(val);
      out.push(val);
    }
    return out;
  }

  function parseIntegerLike(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    const text = String(value).trim();
    if (!text) return undefined;
    const digits = text.replace(/[^0-9.]/g, '');
    if (!digits) return undefined;
    const num = parseFloat(digits);
    if (!Number.isFinite(num)) return undefined;
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

  async function ensurePerformerSchemaCaps() {
    if (performerSchemaCaps) return performerSchemaCaps;
    const query = `
      query PerformerInputCaps {
        performerOutput: __type(name:"Performer") { fields { name } }
        performerUpdate: __type(name:"PerformerUpdateInput") { inputFields { name } }
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
      if (!node) return undefined;
      if (node.name) return node.name;
      return unwrapTypeName(node.ofType);
    };

    try {
      const data = await stashGraphQL(query, {});
      const rawFields = Array.isArray(data?.performerInput?.inputFields) ? data.performerInput.inputFields : [];
      if (!rawFields.some(field => field.name === 'name')) throw new Error('Ofullständigt importschema');
      const inputFields = new Map();
      const listFields = new Set();
      rawFields.forEach(field => {
        if (!field?.name) return;
        const typeName = unwrapTypeName(field.type) || null;
        inputFields.set(field.name, typeName);
        let node = field.type;
        while (node?.kind === 'NON_NULL') node = node.ofType;
        if (node?.kind === 'LIST') listFields.add(field.name);
      });
      const enums = {
        gender: new Set((data?.genderEnum?.enumValues || []).map(e => e?.name).filter(Boolean)),
        ethnicity: new Set((data?.ethnicityEnum?.enumValues || []).map(e => e?.name).filter(Boolean)),
        hair_color: new Set((data?.hairEnum?.enumValues || []).map(e => e?.name).filter(Boolean)),
        eye_color: new Set((data?.eyeEnum?.enumValues || []).map(e => e?.name).filter(Boolean)),
      };
      performerSchemaCaps = { inputFields, listFields, enums,
        outputFields: new Set((data?.performerOutput?.fields || []).map(f => f.name)),
        updateFields: new Set((data?.performerUpdate?.inputFields || []).map(f => f.name)),
      };
      if (!performerSchemaCaps.logged) {
        console.debug('PerformerCreateInput fields', Array.from(inputFields.entries()));
        performerSchemaCaps.logged = true;
      }
    } catch (err) {
      console.error('Kunde inte introspektera PerformerCreateInput', err);
      throw new Error('Kunde inte läsa Stashs importschema. Försök igen.');
    }
    return performerSchemaCaps;
  }

  function mapEnumValue(rawValue, enumName, caps) {
    if (!rawValue) return undefined;
    if (getInputFieldType(caps, enumName) === 'String') return String(rawValue).trim() || undefined;
    const enums = caps?.enums?.[enumName];
    if (!enums || !enums.size) return undefined;
    const normalized = String(rawValue).trim();
    if (!normalized) return undefined;
    const candidate = normalized.replace(/[^\w]+/g, '_').replace(/_+/g, '_').toUpperCase();
    if (enums.has(candidate)) return candidate;
    const overrides = ENUM_OVERRIDES[enumName] || {};
    const override = overrides[candidate];
    if (Array.isArray(override)) {
      for (const val of override) {
        if (enums.has(val)) return val;
      }
    } else if (typeof override === 'string' && enums.has(override)) {
      return override;
    }
    return undefined;
  }

  function canUseInputField(caps, field) {
    if (!caps || !caps.inputFields) return false;
    const inputFields = caps.inputFields;
    if (typeof inputFields.has === 'function') return inputFields.has(field);
    if (typeof inputFields.get === 'function') return inputFields.has(field);
    if (Array.isArray(inputFields)) return inputFields.includes(field);
    return false;
  }

  function getInputFieldType(caps, field) {
    if (!caps || !caps.inputFields) return undefined;
    const inputFields = caps.inputFields;
    if (typeof inputFields.get === 'function') return inputFields.get(field);
    return undefined;
  }

  function isInputObjectType(typeName) {
    if (typeof typeName !== 'string') return false;
    return /INPUT$/i.test(typeName.trim());
  }
  function isUploadType(typeName) {
    if (typeof typeName !== 'string') return false;
    return typeName.trim().toLowerCase() == 'upload';
  }

  const nativeMetadata = globalThis.FaceRecognitionStandalone.metadataClient(stashGraphQL);
  async function fetchStashdbMetadata(name, aliasCandidates, identity = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), pluginSettings.api_timeout * 1000);
    try { return await nativeMetadata.lookup(normalizeCandidateName(name), aliasCandidates || [], pluginSettings, ctrl.signal, identity); }
    finally { clearTimeout(timer); }
  }

  function buildAliasesInput(aliases, caps) {
    const field = canUseInputField(caps, 'alias_list') ? 'alias_list' : 'aliases';
    if (!canUseInputField(caps, field) || !aliases.length) return {};
    return { [field]: caps.listFields?.has(field) ? aliases : aliases.join(', ') };
  }

  async function buildPerformerCreateInput(normalizedName, aliasCandidates, { includeImage = true, identity = {} } = {}) {
    const caps = await ensurePerformerSchemaCaps();
    const canUse = field => canUseInputField(caps, field);
    const metadata = await fetchStashdbMetadata(normalizedName, aliasCandidates, identity);
    const input = {};
    if (!metadata) {
      return { input, metadata: null, caps, canonicalName: normalizedName, imageStrategy: { mode: 'none', url: null } };
    }

    const performer = metadata.performer || {};
    const canonicalName = normalizeCandidateName(performer.name) || normalizedName;
    const primaryNameForAliases = normalizeCandidateName(canonicalName) || normalizedName;

    if (canUse('disambiguation') && performer.disambiguation) {
      input.disambiguation = performer.disambiguation;
    }

    const aliasesFromMetadata = Array.isArray(performer.aliases) ? performer.aliases.map(normalizeCandidateName) : [];
    const aliasesFromArgs = Array.isArray(aliasCandidates) ? aliasCandidates.map(normalizeCandidateName) : [];
    const aliasList = uniqueStrings([...aliasesFromMetadata, ...aliasesFromArgs]).filter(alias => alias && alias !== primaryNameForAliases);
    Object.assign(input, buildAliasesInput(aliasList, caps));

    if (canUse('gender')) {
      const genderValue = mapEnumValue(performer.gender, 'gender', caps);
      if (genderValue) input.gender = genderValue;
    }
    if (canUse('ethnicity')) {
      const ethnicityValue = mapEnumValue(performer.ethnicity, 'ethnicity', caps);
      if (ethnicityValue) input.ethnicity = ethnicityValue;
    }
    if (canUse('country') && performer.country) {
      input.country = performer.country;
    } else if (canUse('country_code') && performer.country) {
      input.country_code = performer.country;
    }
    if (canUse('birthdate') && performer.birthdate) {
      input.birthdate = performer.birthdate;
    }
    if (canUse('death_date') && (performer.death_date || performer.deathdate)) {
      input.death_date = performer.death_date || performer.deathdate;
    }
    if (canUse('hair_color')) {
      const hairValue = mapEnumValue(performer.hair_color, 'hair_color', caps);
      if (hairValue) input.hair_color = hairValue;
    }
    if (canUse('eye_color')) {
      const eyeValue = mapEnumValue(performer.eye_color, 'eye_color', caps);
      if (eyeValue) input.eye_color = eyeValue;
    }
    if (canUse('measurements') && performer.measurements) {
      input.measurements = performer.measurements;
    }

    const heightSource = performer.height_cm ?? performer.height;
    if (canUse('height')) {
      const h = parseIntegerLike(heightSource);
      if (typeof h === 'number' && h > 0) input.height = h;
    } else if (canUse('height_cm')) {
      const h = parseIntegerLike(heightSource);
      if (typeof h === 'number' && h > 0) input.height_cm = h;
    }
    if (canUse('weight')) {
      const w = parseIntegerLike(performer.weight);
      if (typeof w === 'number' && w > 0) input.weight = w;
    }
    if (canUse('career_start') && performer.career_start_year && performer.career_start_year > 0) {
      input.career_start = String(performer.career_start_year);
    }
    if (canUse('career_end') && performer.career_end_year && performer.career_end_year > 0) {
      input.career_end = String(performer.career_end_year);
    }
    if (canUse('tattoos') && Array.isArray(performer.tattoos) && performer.tattoos.length) {
      input.tattoos = performer.tattoos.map(t => [t.location, t.description].filter(Boolean).join(': ')).join(', ');
    }
    if (canUse('piercings') && Array.isArray(performer.piercings) && performer.piercings.length) {
      input.piercings = performer.piercings.map(p => [p.location, p.description].filter(Boolean).join(': ')).join(', ');
    }
    for (const field of ['details', 'career_length', 'penis_length', 'circumcised']) {
      if (canUse(field) && performer[field] !== undefined && performer[field] !== null && performer[field] !== '') input[field] = performer[field];
    }
    if (canUse('fake_tits') && performer.breast_type) {
      input.fake_tits = performer.breast_type;
    }

    if (canUse('urls') || canUse('url')) {
      const baseUrls = Array.isArray(performer.urls) ? performer.urls : [];
      const rawUrlEntries = [];
      baseUrls.forEach(entry => {
        if (!entry) return;
        if (typeof entry === 'string') {
          rawUrlEntries.push(entry);
        } else if (typeof entry === 'object') {
          const candidate = entry.url || entry.href || '';
          if (candidate) rawUrlEntries.push(candidate);
        }
      });
      const social = performer.social || {};
      [['instagram', 'https://instagram.com/'], ['twitter', 'https://twitter.com/'], ['tiktok', 'https://www.tiktok.com/@']].forEach(([key, prefix]) => {
        const value = social?.[key];
        if (typeof value !== 'string') return;
        let href = value.trim();
        if (!href) return;
        if (!/^https?:/i.test(href)) {
          href = `${prefix}${href.replace(/^@+/, '')}`;
        }
        rawUrlEntries.push(href);
      });
      const seen = new Set();
      const urls = [];
      rawUrlEntries.forEach(entry => {
        if (!entry) return;
        let clean = String(entry).trim();
        if (!clean) return;
        if (!/^https?:/i.test(clean)) {
          clean = `https://${clean.replace(/^\/+/, '')}`;
        }
        if (seen.has(clean)) return;
        seen.add(clean);
        urls.push(clean);
      });
      if (urls.length) {
        const urlsTypeRaw = getInputFieldType(caps, 'urls');
        const urlTypeRaw = getInputFieldType(caps, 'url');
        const wantsObjectList = isInputObjectType(urlsTypeRaw);
        if (canUse('urls')) {
          input.urls = wantsObjectList ? urls.map(url => ({ url })) : urls;
        } else if (canUse('url')) {
          const singleIsObject = isInputObjectType(urlTypeRaw);
          input.url = singleIsObject ? { url: urls[0] } : urls[0];
        }
      }
    }

    if (canUse('stash_ids') || canUse('stash_id')) {
      const fallbackEndpoint = metadata.source_endpoint || pluginSettings.stashdb_endpoint || 'https://stashdb.org/graphql';
      const rawStashIds = Array.isArray(performer.stash_ids) ? performer.stash_ids : [];
      const stashIds = [];
      rawStashIds.forEach(entry => {
        if (!entry) return;
        const stashId = entry.stash_id || entry.id;
        if (!stashId) return;
        const endpoint = entry.endpoint || entry.url || fallbackEndpoint;
        stashIds.push({ stash_id: String(stashId), endpoint });
      });
      if (!stashIds.length && performer.id) {
        stashIds.push({ stash_id: String(performer.id), endpoint: fallbackEndpoint });
      }
      if (stashIds.length) {
        if (canUse('stash_ids')) {
          const seen = new Set();
          const uniq = stashIds.filter(item => {
            const key = `${item.endpoint}:${item.stash_id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          input.stash_ids = uniq;
        } else if (canUse('stash_id')) {
          input.stash_id = stashIds[0]?.stash_id;
          if (canUse('stash_endpoint')) input.stash_endpoint = stashIds[0]?.endpoint;
        }
      }
    }

    const imageCandidates = [];
    if (metadata.image_url) imageCandidates.push(metadata.image_url);
    if (performer.image_url) imageCandidates.push(performer.image_url);
    if (performer.image_path) imageCandidates.push(performer.image_path);
    const primaryImageUrl = imageCandidates.find(url => typeof url === 'string' && url.trim());
    let imageStrategy = { mode: 'none', url: null };
    if (primaryImageUrl && includeImage) {
      const cleanUrl = String(primaryImageUrl).trim();
      const imageFieldTypeRaw = getInputFieldType(caps, 'image');
      if (canUse('image_url')) {
        input.image_url = cleanUrl;
        imageStrategy = { mode: 'url', url: cleanUrl };
      } else if (canUse('image') && imageFieldTypeRaw) {
        if (isUploadType(imageFieldTypeRaw)) {
          imageStrategy = { mode: 'upload', url: cleanUrl };
        } else if (isInputObjectType(imageFieldTypeRaw)) {
          input.image = { url: cleanUrl };
          imageStrategy = { mode: 'inline', url: cleanUrl };
        } else {
          input.image = cleanUrl; // Stash downloads URLs or accepts scraper data URLs.
          imageStrategy = { mode: 'inline', url: cleanUrl };
        }
      }
    }

    return { input, metadata, caps, canonicalName, imageStrategy };
  }

  function sanitizeFilename(value) {
    const fallback = 'performer';
    if (value === undefined || value === null) return fallback;
    const trimmed = String(value).trim();
    if (!trimmed) return fallback;
    const cleaned = trimmed.replace(/[^0-9a-zA-Z._-]+/g, '_');
    const normalized = cleaned.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return (normalized || fallback).slice(0, 80);
  }

  async function fetchImageBlobDirect(url) {
    if (!url) return null;
    const href = String(url).trim();
    if (!href) return null;
    const ctrl = new AbortController();
    const timeoutMs = Math.max(3, pluginSettings.api_timeout || 0) * 1000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(href, { signal: ctrl.signal, credentials: 'omit' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (!blob || !blob.size) return null;
      return blob;
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('Kunde inte hämta bild direkt:', err);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function imageBlobToDataURL(blob) {
    if (!blob?.size || !/^image\/(jpeg|png|webp|gif)$/i.test(blob.type)) {
      throw new Error('Bildkällan returnerade ingen giltig profilbild');
    }
    return `data:${blob.type};base64,${arrayBufferToBase64(await blob.arrayBuffer())}`;
  }

  async function fetchImageBlobForPerformer(primaryName, fallbackUrl, metadata) {
    // Prefer the exact image from the matched metadata, not a local placeholder.
    const urls = uniqueStrings([fallbackUrl, metadata?.image_url, metadata?.performer?.image_url, metadata?.performer?.image_path].filter(Boolean));
    for (const url of urls) {
      const blob = await fetchImageBlobDirect(url);
      if (blob?.size && /^image\/(jpeg|png|webp|gif)$/i.test(blob.type)) return blob;
    }
    return null;
  }

  async function uploadPerformerImageBlob(performerId, blob, preferredName) {
    if (!performerId || !blob) return false;
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
    if (text) {
      try { payload = JSON.parse(text); } catch (_) { payload = null; }
    }
    if (!resp.ok || payload?.errors) {
      const message = payload?.errors?.map(e => e?.message).filter(Boolean).join('; ') || `GraphQL HTTP ${resp.status}`;
      const error = new Error(message);
      error.payload = payload ?? text;
      throw error;
    }
    return true;
  }

  async function tryAttachPerformerImage(performerId, canonicalName, imageStrategy, metadata) {
    if (!imageStrategy || imageStrategy.mode !== 'upload') return;
    try {
      const blob = await fetchImageBlobForPerformer(canonicalName, imageStrategy.url, metadata);
      if (!blob) throw new Error('Profilbilden kunde inte hämtas');
      await uploadPerformerImageBlob(performerId, blob, canonicalName);
    } catch (err) {
      console.warn('Kunde inte bifoga performer-bild:', err);
      notify(`Personen skapades, men profilbilden saknas: ${err.message}`, true);
    }
  }

  function notify(msg, isErr = false) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', bottom: '16px', right: '16px',
      background: isErr ? '#b91c1c' : '#166534', color: '#fff',
      padding: '10px 12px', borderRadius: '10px', zIndex: 10000
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  // ---------------- Stash GraphQL helpers ----------------
  async function stashGraphQL(query, variables, init) {
    const resp = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, variables }),
      ...(init || {})
    });

    const text = await resp.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch (_) { payload = null; }
    }

    if (!resp.ok) {
      let message = `GraphQL HTTP ${resp.status}`;
      const errors = payload?.errors;
      if (Array.isArray(errors) && errors.length) {
        const msg = errors.map(e => e?.message).filter(Boolean).join('; ');
        if (msg) message += `: ${msg}`;
      } else if (text) {
        const snippet = text.slice(0, 200).trim();
        if (snippet) message += `: ${snippet}`;
      }
      const error = new Error(message);
      error.status = resp.status;
      error.payload = payload ?? text;
      throw error;
    }

    if (payload?.errors) {
      const msg = payload.errors.map(e => e?.message).filter(Boolean).join('; ');
      const error = new Error(msg || 'GraphQL error');
      error.status = resp.status;
      error.payload = payload;
      throw error;
    }

    return payload?.data ?? null;
  }


  async function fetchPerformerById(id) {
    if (!id) return null;
    const query = `
      query($id: ID!){
        findPerformer(id:$id){ id name }
      }
    `;
    try {
      const data = await stashGraphQL(query, { id: String(id) });
      return data?.findPerformer || null;
    } catch (err) {
      if (err?.status === 422) {
        console.warn('fetchPerformerById 422', err.payload || err.message || err);
        return null;
      }
      console.error('fetchPerformerById fel:', err);
      return null;
    }
  }


  function extractNameFromMessage(message) {
    if (!message) return null;
    const patterns = [
      /performer with name ['"]([^'"]+)['"] already exists/i,
      /name ['"]([^'"]+)['"]/i
    ];
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
    return null;
  }


  const performerQueryCache = new Map();
  function buildPerformerQuery(modifier) {
    if (performerQueryCache.has(modifier)) return performerQueryCache.get(modifier);
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

  async function resolveExistingPerformer(name, aliasCandidates, duplicateDetails, duplicateMessage) {
    const idCandidates = [];
    const idKeys = ["id", "existingId", "duplicateId", "performer_id", "performerId"];
    if (duplicateDetails) {
      for (const key of idKeys) {
        const value = duplicateDetails[key];
        if (value !== undefined && value !== null && value !== "") {
          idCandidates.push(String(value));
        }
      }
    }
    for (const ident of idCandidates) {
      const performer = await fetchPerformerById(ident);
      if (performer) return performer;
    }
    const searchTerms = new Set();
    if (name) searchTerms.add(name);
    const normalizedName = normalizeCandidateName(name);
    if (normalizedName) searchTerms.add(normalizedName);
    if (Array.isArray(aliasCandidates)) {
      for (const alias of aliasCandidates) {
        if (alias) searchTerms.add(alias);
        const normalizedAlias = normalizeCandidateName(alias);
        if (normalizedAlias) searchTerms.add(normalizedAlias);
      }
    }
    const extracted = extractNameFromMessage(duplicateMessage);
    if (extracted) searchTerms.add(extracted);
    const normalizedExtracted = normalizeCandidateName(extracted);
    if (normalizedExtracted) searchTerms.add(normalizedExtracted);
    for (const term of searchTerms) {
      if (!term) continue;
      const performer = await findPerformerByName(term);
      if (performer) return performer;
    }
    console.warn('resolveExistingPerformer miss', { name, searchTerms: Array.from(searchTerms), duplicateDetails, duplicateMessage });
    return null;
  }

  function getCurrentSceneId() {
    // matcher /scenes/12345 eller /scenes/12345?... 
    const m = location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  async function getScenePerformerIds(sceneId) {
    const q = `
      query($id: ID!){
        findScene(id:$id){ id performers { id } }
      }
    `;
    const d = await stashGraphQL(q, { id: sceneId });
    const arr = (d?.findScene?.performers || []).map(p => parseInt(p.id, 10)).filter(n => Number.isFinite(n));
    return Array.from(new Set(arr));
  }

  async function findPerformerByName(name) {
    const normalized = normalizeCandidateName(name);
    if (!normalized) return null;

    const variants = new Set(generateAliasCandidates(name));
    variants.add(name);
    variants.add(normalized);

    const modifiers = ['EQUALS', 'ILIKE', 'CONTAINS'];

    for (const modifier of modifiers) {
      const query = buildPerformerQuery(modifier);
      for (const variant of variants) {
        const term = normalizeCandidateName(variant);
        if (!term) continue;
        try {
          const data = await stashGraphQL(query, { name: variant });
          const performers = data?.findPerformers?.performers || [];
          if (!performers.length) continue;
          const target = modifier === 'EQUALS' ? term.toLowerCase() : null;
          if (target) {
            const match = performers.find(p => normalizeCandidateName(p.name).toLowerCase() === target);
            if (match) return match;
          }
          return performers[0];
        } catch (err) {
          if (err?.status === 422) {
            continue;
          }
          console.error('findPerformerByName fel:', err.payload || err.message || err);
        }
      }
    }

    return null;
  }
  async function createPerformerIfAllowed(name, aliasCandidates) {
    if (!pluginSettings.create_new_performers) return null;
    const normalized = normalizeCandidateName(name);
    if (!normalized) return null;
    const result = await buildPerformerCreateInput(normalized, aliasCandidates);
    // A missing external match is valid: the detected name can stand on its own.
    const input = result.metadata
      ? { ...result.input, name: result.canonicalName }
      : { name: normalized };
    if (result.metadata && !input.aliases && !input.alias_list) {
      Object.assign(input, buildAliasesInput(uniqueStrings([...(aliasCandidates || []), normalized])
        .filter(alias => alias && alias !== input.name), result.caps));
    }
    try {
      const data = await stashGraphQL(`mutation($input: PerformerCreateInput!) {
        performerCreate(input:$input) { id name }
      }`, { input });
      if (!data?.performerCreate) throw new Error('Stash returnerade ingen skapad person');
      if (result.metadata) {
        await tryAttachPerformerImage(data.performerCreate.id, result.canonicalName, result.imageStrategy, result.metadata);
      }
      return data.performerCreate;
    } catch (error) {
      if (/already exists/i.test(error?.message || '')) {
        const details = error?.payload?.errors?.[0]?.extensions || {};
        const existing = await resolveExistingPerformer(name, aliasCandidates, details, error.message);
        if (existing) return completeExistingPerformer(existing, name, aliasCandidates);
      }
      // Do not retry with just a name: that silently loses the requested metadata.
      throw error;
    }
  }

  function profileImageMissing(path) {
    if (!path) return true;
    try { return new URL(path, window.location.origin).searchParams.get('default') === 'true'; }
    catch { return false; }
  }

  function mergeMissingPerformerData(current, imported, caps) {
    const update = { id: String(current.id) };
    for (const [key, value] of Object.entries(imported)) {
      if (key === 'name' || !caps.updateFields.has(key)) continue;
      const previous = current[key];
      if (['alias_list', 'urls', 'stash_ids'].includes(key) && Array.isArray(value)) {
        const signature = item => key === 'stash_ids' ? `${item.endpoint}:${item.stash_id}` : String(item).toLowerCase();
        const merged = [...(Array.isArray(previous) ? previous : [])];
        const seen = new Set(merged.map(signature));
        for (const item of value) {
          if (!seen.has(signature(item))) { merged.push(item); seen.add(signature(item)); }
        }
        if (merged.length !== (previous || []).length) update[key] = merged;
      } else if (previous === undefined || previous === null || previous === '' || previous === 0) {
        update[key] = value;
      }
    }
    return update;
  }

  async function completeExistingPerformer(performer, name, aliases) {
    const caps = await ensurePerformerSchemaCaps();
    const identityFields = ['id', 'name', 'stash_ids'].filter(key => caps.outputFields.has(key))
      .map(key => key === 'stash_ids' ? 'stash_ids { endpoint stash_id }' : key).join(' ');
    if (!caps.outputFields.has('stash_ids')) return performer;
    const identityData = await stashGraphQL(`query($id:ID!){findPerformer(id:$id){${identityFields}}}`, { id: String(performer.id) });
    const identity = identityData?.findPerformer;
    if (!identity || !(identity.stash_ids || []).length) return performer;
    const result = await buildPerformerCreateInput(name, aliases, { includeImage: false, identity });
    if (!result.metadata) return performer;
    const { input, metadata } = result;
    const fields = Object.keys(input).filter(key => caps.outputFields.has(key) && caps.updateFields.has(key));
    const selection = uniqueStrings(['id', 'name', 'image_path', 'stash_ids', ...fields])
      .filter(key => caps.outputFields.has(key))
      .map(key => key === 'stash_ids' ? 'stash_ids { endpoint stash_id }' : key).join(' ');
    const data = await stashGraphQL(`query($id:ID!){findPerformer(id:$id){${selection}}}`, { id: String(performer.id) });
    const current = data?.findPerformer;
    if (!current) return performer;
    // Enrich only an existing record linked to this exact external identity.
    // An identical name by itself is not enough to overwrite or merge profiles.
    const sameEndpoint = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
    const linked = (current.stash_ids || []).some(local => (input.stash_ids || []).some(remote =>
      local.stash_id === remote.stash_id && sameEndpoint(local.endpoint, remote.endpoint)));
    if (!linked) return performer;
    const update = mergeMissingPerformerData(current, input, caps);
    const imageURL = metadata.image_url || metadata.performer?.image_url || metadata.performer?.image_path;
    if (imageURL && caps.updateFields.has('image') && getInputFieldType(caps, 'image') === 'String' && profileImageMissing(current.image_path)) {
      update.image = imageURL;
    }
    if (Object.keys(update).length > 1) {
      await stashGraphQL(`mutation($input:PerformerUpdateInput!){performerUpdate(input:$input){id}}`, { input: update });
      notify('Kompletterade saknad profilbild och metadata');
    }
    return performer;
  }

  async function addPerformerToSceneByName(name) {
    const sceneId = getCurrentSceneId();
    if (!sceneId) { notify('Kunde inte hitta scen-ID', true); return; }

    const aliasCandidates = generateAliasCandidates(name);
    let perf = await findPerformerByName(name);
    if (perf) {
      const scenePerformers = await getScenePerformerIds(sceneId);
      if (scenePerformers.includes(parseInt(perf.id, 10))) {
        notify(`"${perf.name}" finns redan i scenen`);
        return;
      }
      perf = await completeExistingPerformer(perf, name, aliasCandidates);
    }
    if (!perf) {
      try {
        perf = await createPerformerIfAllowed(name, aliasCandidates);
      } catch (err) {
        const messages = [];
        if (err?.message) messages.push(String(err.message));
        const payloadErr = err?.payload?.errors?.[0] || null;
        const payloadMsg = payloadErr?.message;
        if (payloadMsg) messages.push(String(payloadMsg));
        const combined = messages.join(' - ');
        if (/already exists/i.test(combined)) {
          const duplicateDetails = payloadErr?.extensions || {};
          perf = await resolveExistingPerformer(name, aliasCandidates, duplicateDetails, payloadMsg || err?.message);
        }
        if (!perf) throw err;
      }
      if (!perf) {
        notify(`Hittade ingen performer "${normalizeCandidateName(name) || name}"`, true);
        return;
      }
    }

    const existing = await getScenePerformerIds(sceneId);
    const pid = parseInt(perf.id, 10);
    if (existing.includes(pid)) {
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

  // Stash is the single source of truth; commit local state only after a successful save.
  async function saveSettingsToBackend(settings) {
    if (!pluginId) throw new Error('Plugin-inställningarna har inte laddats. Ladda om sidan.');
    const input = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, settings[key]]));
    await stashGraphQL(`mutation ConfigurePlugin($plugin_id: ID!, $input: Map!) {
      configurePlugin(plugin_id: $plugin_id, input: $input)
    }`, { plugin_id: pluginId, input });
    pluginSettings = { ...settings };
    clearImageCache();
  }

  // ---------------- Settings panel (högerklick) ----------------
  function escapeAttr(val) {
    return String(val ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function createSettingsPanel() {
    if (document.querySelector('.fr-settings-panel')) return; // en instans åt gången
    const wrap = document.createElement('div');
    wrap.className = 'fr-settings-panel';
    wrap.innerHTML = `
      <div class="fr-sp-head">Face Recognition - Inställningar</div>
      <div class="fr-sp-body" style="max-height:80vh;overflow-y:auto">
        <label>Analysmotor:</label>
        <select id="fr-compute-backend">
          <option value="auto" ${pluginSettings.compute_backend === 'auto' ? 'selected' : ''}>Automatisk (GPU om tillgänglig)</option>
          <option value="cpu" ${pluginSettings.compute_backend === 'cpu' ? 'selected' : ''}>CPU</option>
        </select>

        <label>Analystimeout (sek):</label>
        <input type="number" id="fr-api-timeout" value="${pluginSettings.api_timeout}" min="30" max="600">

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
        <input type="text" id="fr-image-source" value="${escapeAttr(pluginSettings.image_source)}">

        <label for="fr-metadata-source">Metadatakälla:</label>
        <select id="fr-metadata-source">
          <option value="all" ${pluginSettings.metadata_source === 'all' ? 'selected' : ''}>Alla (StashDB → TPDB → PMVStash → FansDB)</option>
          <option value="stashdb" ${pluginSettings.metadata_source === 'stashdb' ? 'selected' : ''}>StashDB först</option>
          <option value="tpdb" ${pluginSettings.metadata_source === 'tpdb' ? 'selected' : ''}>TPDB först</option>
          <option value="pmvstash" ${pluginSettings.metadata_source === 'pmvstash' ? 'selected' : ''}>PMVStash först</option>
          <option value="fansdb" ${pluginSettings.metadata_source === 'fansdb' ? 'selected' : ''}>FansDB först</option>
        </select>
        <p>I läget Alla används första entydiga träffen i ordningen ovan. Källor som inte är konfigurerade hoppas över.</p>

        <label>StashDB endpoint:</label>
        <input type="text" id="fr-stashdb-endpoint" value="${escapeAttr(pluginSettings.stashdb_endpoint)}">

        <p>Metadata hämtas via dina konfigurerade källor i Stash. Analysen körs i webbläsaren.</p>

        <div class="fr-sp-actions">
          <button type="button" id="fr-sp-test">Testa analysmotor</button>
          <button type="button" id="fr-sp-save">Spara</button>
          <button type="button" id="fr-sp-close">Stäng</button>
        </div>
      </div>`;

    const style = document.createElement('style');
    style.textContent = `
      .fr-settings-panel{position:fixed;top:64px;right:16px;width:340px;background:#16181d;color:#e5e7eb;border:1px solid #2a2f39;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.6);z-index:10000}
      .fr-sp-head{font-weight:600;padding:10px 12px;border-bottom:1px solid #2a2f39}
      .fr-sp-body{padding:12px}
      .fr-sp-body label{display:block;margin-top:10px;margin-bottom:6px;font-size:12px;color:#aab0bb}
      .fr-sp-body input[type=text], .fr-sp-body input[type=number], .fr-sp-body select{width:100%;padding:8px;border-radius:8px;border:1px solid #2a2f39;background:#0f1115;color:#e5e7eb;box-sizing:border-box}
      .fr-sp-body input::placeholder{color:#555;font-style:italic}
      .fr-sp-actions{display:flex;gap:8px;margin-top:14px}
      .fr-sp-actions button{background:#2a61ff;color:#fff;border:0;border-radius:10px;padding:8px 12px;cursor:pointer}
      .fr-sp-actions button#fr-sp-close{background:#3a3f4b}`;
    wrap.appendChild(style);
    document.body.appendChild(wrap);
    wrap.querySelector('#fr-sp-close').addEventListener('click', () => wrap.remove());
    wrap.querySelector('#fr-sp-test').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const health = await globalThis.FaceRecognitionStandalone.health(pluginId, pluginSettings.compute_backend);
        notify(`Analysmotorn fungerar: ${health.backend === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WebAssembly)'}, ${health.identities} identiteter.`);
      } catch (error) {
        notify(`Motortest misslyckades: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    });
    wrap.querySelector('#fr-sp-save').addEventListener('click', () => saveSettingsFromPanel(wrap));
  }
  async function saveSettingsFromPanel(root) {
    const button = root.querySelector('#fr-sp-save');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const value = id => root.querySelector(id).value;
      const checked = id => !!root.querySelector(id).checked;
      const bounded = (id, min, max, fallback) => {
        const parsed = parseInt(value(id), 10);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
      };
      const settings = {
        ...pluginSettings,
        compute_backend: value('#fr-compute-backend'),
        api_timeout: bounded('#fr-api-timeout', 30, 600, 180),
        show_confidence: checked('#fr-show-confidence'),
        min_confidence: bounded('#fr-min-confidence', 0, 100, 20),
        auto_add_performers: checked('#fr-auto-add'),
        create_new_performers: checked('#fr-create-new'),
        max_suggestions: bounded('#fr-max-suggestions', 1, 10, 3),
        image_source: value('#fr-image-source').trim().toLowerCase(),
        metadata_source: value('#fr-metadata-source').trim().toLowerCase(),
        stashdb_endpoint: value('#fr-stashdb-endpoint').trim() || DEFAULT_SETTINGS.stashdb_endpoint,
      };
      if (!['auto', 'cpu'].includes(settings.compute_backend)) throw new Error('Ogiltig analysmotor');
      if (!['local', 'stashdb', 'both'].includes(settings.image_source)) throw new Error('Ogiltig bildkälla');
      if (!['all', 'stashdb', 'tpdb', 'pmvstash', 'fansdb'].includes(settings.metadata_source)) throw new Error('Ogiltig metadatakälla');
      await saveSettingsToBackend(settings);
      globalThis.FaceRecognitionStandalone.reset();
      nativeMetadata.clear();
      notify('Inställningar sparade');
      root.remove();
    } catch (error) {
      console.error('Kunde inte spara inställningar:', error);
      notify(`Kunde inte spara: ${error.message}`, true);
    } finally {
      button.disabled = false;
    }
  }

  // ---------------- Hjälpare för video/overlay ----------------
  function findVideoElement() {
    for (const sel of ['.video-js video', '.vjs-tech', 'video[playsinline]', 'video']) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }
  function findVideoContainer() {
    const video = findVideoElement(); if (!video) return null;
    let c = video.parentElement;
    while (c && c !== document.body) {
      const cs = getComputedStyle(c);
      if (cs.position === 'relative' || cs.position === 'absolute') return c;
      c = c.parentElement;
    }
    return video.parentElement || null;
  }
  function findEditPanelContainer() {
    if (!/^\/scenes\/\d+\/?$/.test(window.location.pathname)) return null;
    const selected = document.querySelector('[role="tab"][data-rb-event-key="scene-edit-panel"][aria-selected="true"]');
    if (!selected) return null;
    return document.querySelector('#scene-edit-details .edit-buttons-container') || document.querySelector('#scene-edit-details');
  }
  function clearOverlay() {
    for (const dispose of Array.from(previewDisposers)) dispose();
    document.querySelectorAll('.frp-preview').forEach(n => n.remove());
    document.querySelectorAll('.frp-overlay').forEach(n => n.remove());
    if (overlayClearTimer) {
      clearTimeout(overlayClearTimer);
      overlayClearTimer = null;
    }
  }
  function ensureOverlay() {
    const cont = findVideoContainer() || document.body;
    let ov = cont.querySelector('.frp-overlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.className = 'frp-overlay';
    const cs = getComputedStyle(cont);
    if (cont === document.body || cs.position === 'static') {
      Object.assign(ov.style, { position: 'fixed', inset: 0 });
    } else {
      ov.style.position = 'absolute';
      ov.style.inset = '0';
    }
    ov.style.pointerEvents = 'none';
    ov.style.zIndex = '2147483647';
    cont.appendChild(ov);
    return ov;
  }

  function scheduleOverlayAutoClear() {
    if (overlayClearTimer) {
      clearTimeout(overlayClearTimer);
    }
    overlayClearTimer = setTimeout(() => {
      overlayClearTimer = null;
      clearOverlay();
    }, 30000);
  }

  // ---------------- Tooltip (förhandsbild) ----------------
  function makePreviewTooltip() {
    const tip = document.createElement('div');
    tip.className = 'frp-preview';
    Object.assign(tip.style, {
      position: 'fixed', left: '0px', top: '0px',
      borderRadius: '10px', border: '1px solid rgba(255,255,255,0.12)',
      background: '#0f1115', boxShadow: '0 8px 18px rgba(0,0,0,.35)',
      pointerEvents: 'none', zIndex: 2147483647,
      overflow: 'visible',
      width: '350px',
      maxWidth: '350px',
      maxHeight: '90vh'
    });

    const img = document.createElement('img');
    img.alt = 'preview';
    img.className = 'frp-avatar';
    Object.assign(img.style, {
      display: 'block',
      width: '350px',
      height: 'auto',
      objectFit: 'contain',
      maxWidth: '350px',
      maxHeight: '90vh'
    });
    img.style.setProperty('max-width', '350px', 'important');
    img.style.setProperty('max-height', '90vh', 'important');
    img.style.setProperty('width', '350px', 'important');
    img.style.setProperty('height', 'auto', 'important');
    img.style.setProperty('object-fit', 'contain', 'important');

    tip.appendChild(img);
    return { tip, img };
  }

  // ---------------- Bild-URL: bytes-mode via backend ----------------
  async function resolveImageURL(name, signal) {
    const cached = getCachedImageHref(name);
    if (cached !== undefined) return cached;
    const href = await nativeMetadata.image(name, pluginSettings, signal);
    storeImageCache(name, href ? { href, objectUrl: false } : null);
    return href;
  }

  // ---------------- Hover-preview per rad ----------------
  function attachHoverPreview(rowEl, name) {
    let tipRef = null;
    let enterTimer = null;
    let pendingCtrl = null;
    let hovered = false;
    let disposed = false;
    const isActive = () => !disposed && hovered && rowEl.isConnected;

    function placeTipNear(el, tip) {
      const r = el.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      const pad = 12;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const desiredRight = r.right + pad;
      const desiredLeft = r.left - tr.width - pad;
      const spaceRight = vw - (r.right + pad);
      const spaceLeft = r.left - pad;
      let placeLeft = false;

      let x = desiredRight;
      if (desiredRight + tr.width > vw - pad) {
        if (desiredLeft >= pad) {
          x = Math.max(pad, desiredLeft);
          placeLeft = true;
        } else {
          x = Math.max(pad, Math.min(vw - tr.width - pad, desiredRight));
        }
      } else if (desiredLeft >= pad && spaceLeft > spaceRight) {
        x = Math.max(pad, desiredLeft);
        placeLeft = true;
      }

      let y = r.top + (r.height - tr.height) / 2;
      const minTop = pad;
      const maxTop = Math.max(pad, vh - tr.height - pad);
      if (y < minTop) y = minTop;
      if (y > maxTop) y = maxTop;

      if (x < pad) {
        x = pad;
        placeLeft = false;
      }
      if (x + tr.width > vw - pad) {
        x = Math.max(pad, vw - tr.width - pad);
      }

      tip.dataset.frPreviewSide = placeLeft ? 'left' : 'right';
      tip.style.left = x + 'px';
      tip.style.top = Math.max(minTop, Math.min(maxTop, y)) + 'px';
    }

    function ensureTipVisible(tip) {
      if (!tip) return;
      const rect = tip.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;
      let left = rect.left;
      let top = rect.top;
      if (rect.left < pad) left = pad;
      if (rect.right > vw - pad) left = Math.max(pad, vw - rect.width - pad);
      if (rect.top < pad) top = pad;
      if (rect.bottom > vh - pad) top = Math.max(pad, vh - rect.height - pad);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    function removeTip() {
      if (tipRef) {
        const img = tipRef.querySelector('img');
        if (img) { img.onload = null; img.onerror = null; }
        tipRef.remove();
        tipRef = null;
      }
    }

    function leave() {
      hovered = false;
      if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
      if (pendingCtrl) { pendingCtrl.abort(); pendingCtrl = null; }
      removeTip();
    }

    function enter() {
      if (disposed || !rowEl.isConnected) return;
      hovered = true;
      if (enterTimer) clearTimeout(enterTimer);
      enterTimer = setTimeout(async () => {
        enterTimer = null;
        if (!isActive() || tipRef) return;
        const ctrl = new AbortController();
        pendingCtrl = ctrl;
        let url;
        try {
          url = await resolveImageURL(name, ctrl.signal);
        } catch (err) {
          if (pendingCtrl === ctrl && err?.name !== 'AbortError') console.error('Preview-fetch misslyckades:', err);
          if (pendingCtrl === ctrl) pendingCtrl = null;
          return;
        }
        if (pendingCtrl !== ctrl || !isActive()) return;
        pendingCtrl = null;
        if (!url || tipRef) return;

        const { tip, img } = makePreviewTooltip();
        tip.dataset.frPreview = name;
        // Measure only while attached, but keep the image hidden until positioned.
        tip.style.visibility = 'hidden';
        tipRef = tip;
        img.onload = () => {
          if (tipRef !== tip) return;
          if (!isActive()) { removeTip(); return; }
          placeTipNear(rowEl, tip);
          ensureTipVisible(tip);
          tip.style.visibility = 'visible';
        };
        img.onerror = () => {
          if (getCachedImageHref(name) === url) imageCache.delete(name);
          if (tipRef === tip) removeTip();
        };
        document.body.appendChild(tip);
        img.src = url;
      }, 150);
    }

    function move() {
      if (!isActive()) { leave(); return; }
      if (!tipRef || tipRef.style.visibility !== 'visible') return;
      placeTipNear(rowEl, tipRef);
      ensureTipVisible(tipRef);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      leave();
      rowEl.removeEventListener('mouseenter', enter);
      rowEl.removeEventListener('mousemove', move);
      rowEl.removeEventListener('mouseleave', leave);
      window.removeEventListener('resize', leave);
      window.removeEventListener('scroll', leave, true);
      previewDisposers.delete(dispose);
    }
    rowEl.addEventListener('mouseenter', enter);
    rowEl.addEventListener('mousemove', move);
    rowEl.addEventListener('mouseleave', leave);
    window.addEventListener('resize', leave);
    window.addEventListener('scroll', leave, true);
    previewDisposers.add(dispose);
    return dispose;
  }

  // ---------------- Overlay-rendering ----------------
  function renderRecognizeOverlay(items) {
    clearOverlay();
    if (!items || !items.length) return;
    const video = findVideoElement();
    if (!video) { notify('Ingen video för overlay', true); return; }
    const ov = ensureOverlay();
    const r = video.getBoundingClientRect();
    const vw = video.clientWidth || r.width;
    const vh = video.clientHeight || r.height;
    const iw = video.videoWidth || vw;
    const ih = video.videoHeight || vh;
    const sx = vw / iw, sy = vh / ih;

    items.forEach(face => {
      const { x, y, w, h } = face.box;
      const left = r.left + x * sx;
      const top = r.top + y * sy;
      const width = w * sx;
      const height = h * sy;

      const box = document.createElement('div');
      box.className = 'frp-face-box';
      Object.assign(box.style, {
        position: 'fixed', left: left + 'px', top: top + 'px',
        width: width + 'px', height: height + 'px',
        border: '2px solid rgba(0,200,255,0.9)', borderRadius: '6px',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.35), 0 4px 14px rgba(0,0,0,0.4)',
        pointerEvents: 'auto', cursor: 'pointer', transition: 'border-color .15s'
      });

      const sug = document.createElement('div');
      sug.className = 'frp-suggestions';
      Object.assign(sug.style, {
        position: 'absolute', left: '0px', top: '100%', marginTop: '6px',
        minWidth: '240px', background: 'rgba(18,18,18,0.92)', color: '#f2f2f2',
        border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px',
        overflow: 'hidden', backdropFilter: 'blur(6px)', pointerEvents: 'auto'
      });
      sug.style.setProperty('display', 'none', 'important');

      const rowPreviewDisposers = [];
      const minPct = Math.max(0, Math.min(100, pluginSettings.min_confidence));
      const cands = (face.candidates || [])
        .filter(c => (c.score * 100) >= minPct)
        .slice(0, pluginSettings.max_suggestions || 3);

      if (cands.length === 0) {
        const row = document.createElement('div');
        Object.assign(row.style, { padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)' });
        row.textContent = '(inga kandidater över tröskeln)';
        sug.appendChild(row);
      } else {
        cands.forEach(c => {
          const row = document.createElement('div');
          Object.assign(row.style, {
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '8px 10px', lineHeight: '1.25',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            cursor: 'pointer'
          });
          const span = document.createElement('span');
          span.textContent = pluginSettings.show_confidence ? `${c.name} (${Math.round(c.score * 100)}%)` : c.name;
          Object.assign(span.style, { fontSize: '14px', fontWeight: '600', color: '#f7f7f7', textShadow: '0 1px 1px rgba(0,0,0,0.4)' });
          row.appendChild(span);

          // --- NYTT: klick = lägg till i scenen ---
          row.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            row.style.opacity = '0.6';
            try {
              await addPerformerToSceneByName(c.name);
              rowPreviewDisposers.forEach(dispose => dispose());
              box.remove(); // Ta bort bounding boxen om det lyckades
            } catch (err) {
              console.error(err);
              notify(`Misslyckades: ${err.message || err}`, true);
              row.style.opacity = ''; // Återställ endast vid fel
            }
          });

          sug.appendChild(row);
          rowPreviewDisposers.push(attachHoverPreview(row, c.name));
        });
        const last = sug.lastElementChild; if (last) last.style.borderBottom = 'none';
      }

      box.appendChild(sug);

      // Visa/dölj namnlistan med fördröjning
      let hideTimer = null;
      function showSug() {
        clearTimeout(hideTimer);
        sug.style.setProperty('display', 'block', 'important');
        box.style.setProperty('border-color', 'rgba(0, 200, 255, 1)', 'important');
        box.style.setProperty('z-index', '100', 'important');
      }
      function schedulHide() {
        hideTimer = setTimeout(() => {
          sug.style.setProperty('display', 'none', 'important');
          box.style.setProperty('border-color', 'rgba(0, 200, 255, 0.9)', 'important');
          box.style.setProperty('z-index', 'auto', 'important');
        }, 400);
      }

      box.addEventListener('mouseenter', showSug);
      box.addEventListener('mouseleave', schedulHide);
      sug.addEventListener('mouseenter', showSug);
      sug.addEventListener('mouseleave', schedulHide);

      ov.appendChild(box);
    });

    scheduleOverlayAutoClear();
  }

  // ---------------- UI-knapp ----------------
  function updateRecognitionButton(btn) {
    btn.disabled = recognitionInFlight;
    btn.setAttribute('aria-busy', String(recognitionInFlight));
    btn.setAttribute('aria-label', recognitionInFlight ? 'Analyserar bildruta' : 'Identifiera ansikten');
    const label = btn.querySelector('.frp-fab-text');
    if (label) label.textContent = recognitionInFlight ? 'Analyserar…' : 'Identifiera';
  }
  function setRecognitionBusy(busy) {
    recognitionInFlight = busy;
    document.querySelectorAll('.frp-fab').forEach(updateRecognitionButton);
  }
  function createPluginButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frp-fab';
    btn.innerHTML = `<span class="frp-fab-icon" aria-hidden="true">👁</span><span class="frp-fab-text">Identifiera</span>`;
    btn.title = 'Identifiera ansikten (vänsterklick) — Inställningar (högerklick)';
    updateRecognitionButton(btn);
    btn.addEventListener('click', performFaceRecognition);
    btn.addEventListener('contextmenu', e => { e.preventDefault(); createSettingsPanel(); });
    return btn;
  }
  function ensurePanelPlacement(btn, panelHost) {
    btn.classList.add('frp-fab--panel');
    btn.classList.remove('frp-fab--floating', 'frp-fab--global');

    let wrap = btn.closest('.frp-fab-wrapper');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'frp-fab-wrapper frp-fab-wrapper--panel';
      const parent = btn.parentElement;
      if (parent) {
        parent.insertBefore(wrap, btn);
      }
      wrap.appendChild(btn);
    } else {
      wrap.classList.add('frp-fab-wrapper--panel');
    }

    if (!panelHost.contains(wrap)) {
      const insertBefore = panelHost.firstElementChild;
      if (insertBefore) {
        panelHost.insertBefore(wrap, insertBefore);
      } else {
        panelHost.appendChild(wrap);
      }
    }
  }
  function addPluginButton() {
    const panelHost = findEditPanelContainer();
    let btn = document.querySelector('.frp-fab');
    if (!panelHost) {
      clearOverlay();
      document.querySelectorAll('.frp-fab-wrapper, .frp-fab').forEach(node => node.remove());
      return;
    }
    if (!btn) btn = createPluginButton();
    ensurePanelPlacement(btn, panelHost);
  }

  // ---------------- Huvudflöde ----------------
  async function performFaceRecognition() {
    if (recognitionInFlight) return;
    const scenePath = window.location.pathname;
    try {
      const video = findVideoElement(); if (!video) return notify('Ingen video hittad', true);
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        return notify('Video ej redo. Starta videon och pausa på en bildruta först.', true);
      }
      setRecognitionBusy(true);

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
      if (!blob) return notify('Kunde inte skapa bild', true);

      try {
        const data = await globalThis.FaceRecognitionStandalone.recognize(pluginId, blob, pluginSettings.max_suggestions || 3, pluginSettings.api_timeout * 1000, pluginSettings.compute_backend);
        // Discard a completed analysis after navigation; never apply it to a new scene.
        if (window.location.pathname !== scenePath) return;
        if (!Array.isArray(data)) throw new Error('Analysmotorn returnerade ett ogiltigt svar');
        renderRecognizeOverlay(data);
        if (!data.length) notify('Inga ansikten hittades i bildrutan. Prova en annan bildruta.');
      } catch (err) {
        if (err.name === 'AbortError') {
          notify('Analystimeout uppnådd', true);
        } else {
          console.error(err);
          notify(`Fel vid ansiktsigenkänning: ${err.message || err}`, true);
        }
      }
    } catch (e) {
      console.error('Oväntat fel i performFaceRecognition:', e);
      notify('Oväntat fel vid ansiktsigenkänning', true);
    } finally {
      setRecognitionBusy(false);
    }
  }

  function observePlayerMounts() {
    let pending = null;
    const selector = 'video, .video-js, .scene-tabs, #scene-edit-details, [role="tab"], .frp-fab';
    const relevant = node => node.nodeType === 1 &&
      (node.matches(selector) || !!node.querySelector(selector));
    const schedule = () => {
      if (pending !== null) return;
      pending = setTimeout(() => { pending = null; addPluginButton(); }, 100);
    };
    const observer = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' ? relevant(record.target) : [...record.addedNodes, ...record.removedNodes].some(relevant))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
    globalThis.PluginApi?.Event?.addEventListener('stash:location', schedule);
    addPluginButton();
  }

  async function init() {
    await mergePluginSettingsFromBackend();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', observePlayerMounts, { once: true });
    } else {
      observePlayerMounts();
    }
  }

  init().catch(e => console.error('Initfel:', e));
})();
