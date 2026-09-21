// face-recognition.js — bytes-mode bildhämtning via backend-proxy (CSP-safe)
// + Klick på förslag = lägg till performer i aktuell scen via Stash GraphQL

(function () {
  const LEGACY_LS_KEY = 'face_recognition_plugin_settings';
  const imageCache = new Map(); // name -> { href, objectUrl } | null

  const STASH_PLUGIN_NAME = 'Face Recognition Plugin';
  let pluginId = null; // Stash internal plugin ID, resolved at runtime

  const DEFAULT_SETTINGS = Object.freeze({
    api_url: '/face-api',
    api_timeout: 30,
    show_confidence: true,
    min_confidence: 20,
    auto_add_performers: false,
    create_new_performers: false,
    max_suggestions: 3,
    image_source: 'both', // local|stashdb|both (skickas till backend)
    stashdb_endpoint: 'https://stashdb.org/graphql',
    metadata_source: 'stashdb', // stashdb|tpdb|pmvstash|fansdb
  });
  let pluginSettings = { ...DEFAULT_SETTINGS };

  let overlayClearTimer = null;
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
        return Number.isFinite(num) ? num : undefined;
      }
      case 'api_url':
      case 'stashdb_endpoint': {
        const text = String(value).trim();
        return text ? text : undefined;
      }
      case 'image_source':
      case 'metadata_source': {
        const text = String(value).trim().toLowerCase();
        return text ? text : undefined;
      }
      case 'stashdb_api_key':
      case 'tpdb_api_key':
      case 'pmvstash_api_key':
      case 'fansdb_api_key':
        return undefined; // Credentials belong to the API service, never the browser.
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
      pluginSettings.api_url = normalizeApiBaseUrl(pluginSettings.api_url) || DEFAULT_SETTINGS.api_url;
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

  function normalizeApiBaseUrl(value) {
    const text = String(value || '').trim().replace(/\/+$/, '');
    if (!text) return '';
    if (text.startsWith('/') && !text.startsWith('//') && !/[\\?#\s]/.test(text)) return text;
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('API-URL måste vara /face-api eller en HTTP(S)-adress utan inloggningsuppgifter');
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
  }

  function buildApiUrl(pathname = '', params) {
    try {
      const base = normalizeApiBaseUrl(pluginSettings.api_url);
      if (!base) throw new Error('API-URL saknas');
      const target = new URL(base + '/' + pathname.replace(/^\/+/, ''), window.location.origin);
      if (window.location.protocol === 'https:' && target.protocol === 'http:') {
        throw new Error('Använd /face-api eller en HTTPS-adress när Stash körs över HTTPS');
      }
      for (const [key, value] of Object.entries(params || {})) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined && item !== null) target.searchParams.append(key, String(item));
        }
      }
      return { href: target.href, error: null };
    } catch (error) {
      return { href: '', error };
    }
  }

  async function fetchStashdbMetadata(name, aliasCandidates) {
    const normalized = normalizeCandidateName(name);
    if (!normalized) return null;
    const params = {
      name: normalized,
      stashdb_endpoint: pluginSettings.stashdb_endpoint || 'https://stashdb.org/graphql',
      source: pluginSettings.metadata_source || 'stashdb',
    };
    if (Array.isArray(aliasCandidates) && aliasCandidates.length) {
      const extras = uniqueStrings(aliasCandidates.map(normalizeCandidateName)).filter(val => val && val !== normalized);
      if (extras.length) params.alias = extras;
    }
    const apiInfo = buildApiUrl('stashdb/performer', params);
    if (apiInfo?.error) {
      throw apiInfo.error;
    }
    const ctrl = new AbortController();
    const timeoutMs = Math.max(3, pluginSettings.api_timeout || 0) * 1000;
    const handle = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(apiInfo.href, { method: 'GET', signal: ctrl.signal });
      if (resp.status === 404) return null;
      if (!resp.ok) {
        throw new Error(`Metadata kunde inte hämtas (HTTP ${resp.status})`);
      }
      const data = await resp.json();
      if (!data || !data.performer) throw new Error('Metadata-API:t returnerade ett ogiltigt svar');
      return data;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Fel vid hämtning av StashDB-metadata:', err);
      }
      throw err;
    } finally {
      clearTimeout(handle);
    }
  }

  function buildAliasesInput(aliases, caps) {
    const field = canUseInputField(caps, 'alias_list') ? 'alias_list' : 'aliases';
    if (!canUseInputField(caps, field) || !aliases.length) return {};
    return { [field]: caps.listFields?.has(field) ? aliases : aliases.join(', ') };
  }

  async function buildPerformerCreateInput(normalizedName, aliasCandidates, { includeImage = true } = {}) {
    const caps = await ensurePerformerSchemaCaps();
    const canUse = field => canUseInputField(caps, field);
    const metadata = await fetchStashdbMetadata(normalizedName, aliasCandidates);
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
          // Stash's String image input accepts a data URL. Download first so a
          // remote image failure cannot trigger a metadata-free second create.
          const blob = await fetchImageBlobForPerformer(canonicalName, cleanUrl, metadata);
          if (!blob) throw new Error('Profilbilden kunde inte hämtas. Ingen ofullständig person skapades.');
          input.image = await imageBlobToDataURL(blob);
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

  async function fetchImageBlobViaApi(name, metadata) {
    const candidate = normalizeCandidateName(name);
    if (!candidate) return null;
    const apiInfo = buildApiUrl('resolve_image', {
      name: candidate,
      source: imageMetadataSource(metadata),
      stashdb_endpoint: metadata?.source_endpoint || pluginSettings.stashdb_endpoint,
      format: 'bytes'
    });
    if (apiInfo?.error || !apiInfo.href) return null;
    const ctrl = new AbortController();
    const timeoutMs = Math.max(3, pluginSettings.api_timeout || 0) * 1000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(apiInfo.href, { signal: ctrl.signal });
      if (!resp.ok || resp.status === 204) return null;
      const blob = await resp.blob();
      if (!blob || !blob.size) return null;
      return blob;
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('Kunde inte hämta bild via API:', err);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
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

  function imageMetadataSource(metadata) {
    const endpoints = { 'stashdb.org': 'stashdb', 'theporndb.net': 'tpdb', 'pmvstash.org': 'pmvstash', 'fansdb.cc': 'fansdb' };
    try { return endpoints[new URL(metadata.source_endpoint).hostname] || pluginSettings.metadata_source; }
    catch { return pluginSettings.metadata_source; }
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
    // Same-origin proxy is the fallback when the remote image blocks CORS.
    const names = uniqueStrings([metadata?.performer?.name, primaryName].filter(Boolean));
    for (const name of names) {
      const blob = await fetchImageBlobViaApi(name, metadata);
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
    if (!result.metadata) throw new Error('Ingen extern metadata hittades. Personen skapades inte.');
    const input = { ...result.input, name: result.canonicalName };
    if (!input.aliases && !input.alias_list) {
      Object.assign(input, buildAliasesInput(uniqueStrings([...(aliasCandidates || []), normalized])
        .filter(alias => alias && alias !== input.name), result.caps));
    }
    try {
      const data = await stashGraphQL(`mutation($input: PerformerCreateInput!) {
        performerCreate(input:$input) { id name }
      }`, { input });
      if (!data?.performerCreate) throw new Error('Stash returnerade ingen skapad person');
      await tryAttachPerformerImage(data.performerCreate.id, result.canonicalName, result.imageStrategy, result.metadata);
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
    const result = await buildPerformerCreateInput(name, aliases, { includeImage: false });
    if (!result.metadata) return performer;
    const { caps, input, metadata, canonicalName } = result;
    const fields = Object.keys(input).filter(key => caps.outputFields.has(key) && caps.updateFields.has(key));
    const selection = uniqueStrings(['id', 'name', 'image_path', 'stash_ids', ...fields])
      .filter(key => caps.outputFields.has(key))
      .map(key => key === 'stash_ids' ? 'stash_ids { endpoint stash_id }' : key).join(' ');
    if (!selection) return performer;
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
      const blob = await fetchImageBlobForPerformer(canonicalName, imageURL, metadata);
      if (!blob) throw new Error('Profilbilden kunde inte hämtas. Försök igen.');
      update.image = await imageBlobToDataURL(blob);
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
    if (perf) perf = await completeExistingPerformer(perf, name, aliasCandidates);
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
        <label>API URL:</label>
        <input type="text" id="fr-api-url" value="${escapeAttr(pluginSettings.api_url)}">

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
        <input type="text" id="fr-image-source" value="${escapeAttr(pluginSettings.image_source)}">

        <label>Metadatakälla (stashdb | tpdb | pmvstash | fansdb):</label>
        <input type="text" id="fr-metadata-source" value="${escapeAttr(pluginSettings.metadata_source)}">

        <label>StashDB endpoint:</label>
        <input type="text" id="fr-stashdb-endpoint" value="${escapeAttr(pluginSettings.stashdb_endpoint)}">

        <p>API-nycklar hanteras av API-tjänsten på servern.</p>

        <div class="fr-sp-actions">
          <button type="button" id="fr-sp-test">Testa anslutning</button>
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
      .fr-sp-body input[type=text], .fr-sp-body input[type=number]{width:100%;padding:8px;border-radius:8px;border:1px solid #2a2f39;background:#0f1115;color:#e5e7eb;box-sizing:border-box}
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const info = buildApiUrl('api/health');
        if (info.error) throw info.error;
        const response = await fetch(info.href, { signal: ctrl.signal });
        if (!response.ok) throw new Error(`API-fel ${response.status}`);
        const health = await response.json();
        if (!health.model_loaded) throw new Error('Modellen är inte laddad');
        notify(`Anslutningen fungerar. API ${health.version}, modellen är laddad.`);
      } catch (error) {
        notify(`Anslutningstest misslyckades: ${error.message}`, true);
      } finally {
        clearTimeout(timer);
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
        api_url: normalizeApiBaseUrl(value('#fr-api-url')) || DEFAULT_SETTINGS.api_url,
        api_timeout: bounded('#fr-api-timeout', 1, 120, 30),
        show_confidence: checked('#fr-show-confidence'),
        min_confidence: bounded('#fr-min-confidence', 0, 100, 20),
        auto_add_performers: checked('#fr-auto-add'),
        create_new_performers: checked('#fr-create-new'),
        max_suggestions: bounded('#fr-max-suggestions', 1, 10, 3),
        image_source: value('#fr-image-source').trim().toLowerCase(),
        metadata_source: value('#fr-metadata-source').trim().toLowerCase(),
        stashdb_endpoint: value('#fr-stashdb-endpoint').trim() || DEFAULT_SETTINGS.stashdb_endpoint,
      };
      if (!['local', 'stashdb', 'both'].includes(settings.image_source)) throw new Error('Ogiltig bildkälla');
      if (!['stashdb', 'tpdb', 'pmvstash', 'fansdb'].includes(settings.metadata_source)) throw new Error('Ogiltig metadatakälla');
      await saveSettingsToBackend(settings);
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
  function findInfoPanelContainer() {
    const hintSelectors = [
      '[data-testid="scene-details-panel"]',
      '.scene-details-panel',
      '.scene-tabs .scene-details',
      '.scene-tabs .scene-info',
      '.SceneDetails',
      '.SceneInfoPanel'
    ];
    for (const sel of hintSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    const videoHost = findVideoContainer();
    if (!videoHost) return null;
    const videoRect = videoHost.getBoundingClientRect ? videoHost.getBoundingClientRect() : null;
    let parent = videoHost.parentElement;

    while (parent && parent !== document.body) {
      let style;
      try { style = getComputedStyle(parent); } catch (_) { style = null; }
      const isLayout = !!style && (style.display === 'flex' || style.display === 'grid');
      if (isLayout) {
        const children = Array.from(parent.children);
        const idx = children.findIndex(child => child === videoHost || child.contains(videoHost));
        if (idx > -1) {
          for (let i = idx - 1; i >= 0; i--) {
            const sibling = children[i];
            if (!sibling || sibling === videoHost) continue;
            if (sibling.contains(videoHost)) continue;
            if (sibling.querySelector('video')) continue;
            if (videoRect && sibling.getBoundingClientRect) {
              const rect = sibling.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) continue;
              if (rect.right > (videoRect.left + 20)) continue;
            }
            const text = (sibling.textContent || '').trim();
            if (text.length < 20 && !sibling.querySelector('[data-testid], [data-scene-id], .tag-chip, table, .MuiChip-root, .key-value-row')) continue;
            return sibling;
          }
        }
      }
      parent = parent.parentElement;
    }

    return null;
  }
  function clearOverlay() {
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
  function bytesEndpointFor(name) {
    const info = buildApiUrl('resolve_image', {
      name,
      source: pluginSettings.image_source,
      stashdb_endpoint: pluginSettings.stashdb_endpoint,
      metadata_source: pluginSettings.metadata_source,
      format: 'bytes'
    });
    if (info.error) {
      throw info.error;
    }
    return info.href;
  }

  async function resolveImageURL(name, signal) {
    const cached = getCachedImageHref(name);
    if (cached !== undefined) return cached;

    let endpoint;
    try {
      endpoint = bytesEndpointFor(name);
    } catch (err) {
      console.error('Kunde inte bygga bild-URL:', err);
      storeImageCache(name, null);
      return null;
    }

    try {
      const resp = await fetch(endpoint, { signal });
      if (resp.status === 204) {
        storeImageCache(name, null);
        return null;
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      if (!blob || !blob.size) {
        storeImageCache(name, null);
        return null;
      }
      const buffer = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const contentType = resp.headers.get('Content-Type') || 'image/jpeg';
      const dataUrl = `data:${contentType};base64,${base64}`;
      storeImageCache(name, { href: dataUrl, objectUrl: false });
      return dataUrl;
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw err;
      }
      console.error('Kunde inte hämta preview-bild:', err);
      return null;
    }
  }

  // ---------------- Hover-preview per rad ----------------
  function attachHoverPreview(rowEl, name) {
    let tipRef = null;
    let enterTimer = null;
    let pendingCtrl = null;

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
        tipRef.remove();
        tipRef = null;
      }
    }

    rowEl.addEventListener('mouseenter', () => {
      if (enterTimer) clearTimeout(enterTimer);
      enterTimer = setTimeout(async () => {
        if (tipRef) return;
        const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
        pendingCtrl = ctrl;
        let url;
        try {
          url = await resolveImageURL(name, ctrl ? ctrl.signal : undefined);
        } catch (err) {
          if (err?.name !== 'AbortError') {
            console.error('Preview-fetch misslyckades:', err);
          }
          if (pendingCtrl === ctrl) pendingCtrl = null;
          return;
        }
        if (pendingCtrl !== ctrl) {
          return;
        }
        pendingCtrl = null;
        if (!url || tipRef) return;

        const { tip, img } = makePreviewTooltip();
        tip.dataset.frPreview = name;
        tip.style.width = '350px';
        tip.style.maxWidth = '350px';
        tip.style.maxHeight = '80vh';
        img.style.maxWidth = '350px';
        img.style.width = '350px';
        img.style.height = 'auto';
        img.style.objectFit = 'contain';
        tipRef = tip;

        img.onload = () => {
          if (tipRef !== tip) return;
          if (!tip.parentNode) document.body.appendChild(tip);
          placeTipNear(rowEl, tip);
          ensureTipVisible(tip);
        };
        img.onerror = () => {
          if (getCachedImageHref(name) === url) {
            imageCache.delete(name);
          }
          if (tipRef === tip) {
            tipRef = null;
          }
          tip.remove();
        };
        if (!tip.parentNode) document.body.appendChild(tip);
        img.src = url;
      }, 150);
    });

    rowEl.addEventListener('mousemove', () => {
      if (!tipRef) return;
      placeTipNear(rowEl, tipRef);
      ensureTipVisible(tipRef);
    });

    rowEl.addEventListener('mouseleave', () => {
      if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
      if (pendingCtrl) {
        try { pendingCtrl.abort(); } catch (_) { }
        pendingCtrl = null;
      }
      removeTip();
    });
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
              box.remove(); // Ta bort bounding boxen om det lyckades
              document.querySelectorAll('.frp-preview').forEach(p => p.remove()); // Ta bort eventuell preview
            } catch (err) {
              console.error(err);
              notify(`Misslyckades: ${err.message || err}`, true);
              row.style.opacity = ''; // Återställ endast vid fel
            }
          });

          sug.appendChild(row);
          attachHoverPreview(row, c.name);
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
  function resetFabAnchors() {
    document.querySelectorAll('.frp-fab-anchor').forEach(node => {
      if (!node.querySelector('.frp-fab')) node.classList.remove('frp-fab-anchor');
    });
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
  function ensureFloatingPlacement(btn, host) {
    btn.classList.add('frp-fab--floating');
    btn.classList.remove('frp-fab--panel');

    const wrap = btn.closest('.frp-fab-wrapper');
    if (wrap) {
      wrap.replaceWith(btn);
    }

    if (btn.parentElement !== host) {
      host.appendChild(btn);
    }

    if (host === document.body) {
      btn.classList.add('frp-fab--global');
    } else {
      btn.classList.remove('frp-fab--global');
      const cs = window.getComputedStyle(host);
      if (cs.position === 'static') {
        host.classList.add('frp-fab-anchor');
      }
    }
  }
  function addPluginButton() {
    const panelHost = findInfoPanelContainer();
    const fallbackHost = findVideoContainer() || document.body;
    const host = panelHost || fallbackHost;
    if (!host) return;

    let btn = document.querySelector('.frp-fab');
    if (btn) {
      if (panelHost && panelHost.contains(btn)) {
        ensurePanelPlacement(btn, panelHost);
        return;
      }
      if (!panelHost && host.contains(btn) && btn.classList.contains('frp-fab--floating')) {
        ensureFloatingPlacement(btn, host);
        return;
      }
      const wrap = btn.closest('.frp-fab-wrapper');
      if (wrap) {
        wrap.remove();
      } else {
        btn.remove();
      }
    } else {
      btn = createPluginButton();
    }

    resetFabAnchors();

    if (panelHost) {
      ensurePanelPlacement(btn, panelHost);
    } else {
      ensureFloatingPlacement(btn, host);
    }
  }

  // ---------------- Huvudflöde ----------------
  async function performFaceRecognition() {
    if (recognitionInFlight) return;
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

      const fd = new FormData();
      fd.append('image', new File([blob], 'frame.jpg', { type: 'image/jpeg' }));
      const ctrl = new AbortController();

      const timeoutMs = Math.max(3, pluginSettings.api_timeout) * 1000;
      let timeoutHandle = null;
      let apiInfo = null;
      try {
        timeoutHandle = setTimeout(() => ctrl.abort(), timeoutMs);
        // Request every detected face; the plugin applies its own confidence filter.
        // The API's default gender filter can otherwise silently discard all results.
        apiInfo = buildApiUrl('recognize', { top_k: pluginSettings.max_suggestions || 3, raw_faces: 1 });
        if (apiInfo?.error) {
          console.error('Ogiltig API-URL:', apiInfo.error);
          notify(apiInfo.error.message, true);
          return;
        }
        const resp = await fetch(apiInfo.href, { method: 'POST', body: fd, signal: ctrl.signal });
        if (!resp.ok) throw new Error(`API-fel ${resp.status}`);
        const data = await resp.json();
        if (!Array.isArray(data)) throw new Error('API:t returnerade ett ogiltigt svar');
        renderRecognizeOverlay(data);
        if (!data.length) notify('Inga ansikten hittades i bildrutan. Prova en annan bildruta.');
      } catch (err) {
        if (err.name === 'AbortError') {
          notify('API-timeout uppnådd', true);
        } else {
          console.error(err);
          notify(`Fel vid ansiktsigenkänning: ${err.message || err}`, true);
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
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
    const selector = 'video, .video-js, .scene-tabs, .scene-info, .scene-info-panel, .scene-details-panel, [data-testid="scene-details-panel"], .SceneDetails, .SceneInfoPanel, .frp-fab';
    const relevant = node => node.nodeType === 1 &&
      (node.matches(selector) || !!node.querySelector(selector));
    const schedule = () => {
      if (pending !== null) return;
      pending = setTimeout(() => { pending = null; addPluginButton(); }, 100);
    };
    const observer = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(relevant))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
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
