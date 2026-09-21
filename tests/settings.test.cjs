const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'face-recognition.js'), 'utf8');
const entry = "init().catch(e => console.error('Initfel:', e));";
function setup(response) {
  const storage = new Map([['face_recognition_plugin_settings', '{"api_url":"https://stale.test","stashdb_api_key":"old"}']]);
  const requests = [], warnings = [], timers = [];
  let observer;
  const context = {
    URL, console: { warn: (...args) => warnings.push(args), error() {} },
    window: { location: { origin: 'https://stash.test', protocol: 'https:' }, addEventListener() {} },
    document: { body: {}, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { removeItem: key => storage.delete(key) },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    fetch: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return { ok: true, text: async () => JSON.stringify(response) };
    },
  };
  vm.runInNewContext(source.replace(entry, `globalThis.api = {
    load: mergePluginSettingsFromBackend, save: saveSettingsToBackend, url: buildApiUrl,
    normalize: normalizeApiBaseUrl, observe: observePlayerMounts,
    get: () => ({...pluginSettings}), set: value => { pluginSettings = value; },
    mockMount: fn => { addPluginButton = fn; }
  };`), context);
  return { api: context.api, storage, requests, warnings, timers, mutate: records => observer(records) };
}
const server = values => ({ data: { plugins: [{id:'installed-face-plugin',name:'Face Recognition Plugin'}], configuration:{plugins:{'installed-face-plugin':values}} } });
test('server settings are authoritative, legacy cache and browser credentials are discarded', async () => {
  const t = setup(server({api_url:'/face-api/',api_timeout:'15',show_confidence:'false',image_source:'LOCAL',stashdb_api_key:'secret',unrelated:1}));
  await t.api.load();
  assert.equal(t.api.get().api_url, '/face-api');
  assert.equal(t.api.get().api_timeout, 15);
  assert.equal(t.api.get().show_confidence, false);
  assert.equal(t.api.get().image_source, 'local');
  assert.equal(t.api.get().max_suggestions, 3);
  assert.equal(t.api.get().stashdb_api_key, undefined);
  assert.equal(t.api.get().unrelated, undefined);
  assert.equal(t.storage.size, 0);
  assert.equal(t.requests[0].url, '/graphql');
  assert.equal(t.requests[0].credentials, 'include');
});
test('missing server settings use defaults, not stale browser settings', async () => {
  const t = setup(server({})); await t.api.load();
  assert.equal(t.api.get().api_url, '/face-api'); assert.equal(t.storage.size, 0);
});
test('read failure keeps defaults and preserves old cache for recovery', async () => {
  const t = setup({errors:[{message:'Unavailable'}]}); await t.api.load();
  assert.equal(t.api.get().api_url, '/face-api'); assert.equal(t.storage.size, 1); assert.equal(t.warnings.length, 1);
});
test('save failure does not commit settings', async () => {
  const reply = server({}); const t = setup(reply); await t.api.load();
  reply.errors = [{message:'Write failed'}];
  await assert.rejects(t.api.save({...t.api.get(),max_suggestions:8}),/Write failed/);
  assert.equal(t.api.get().max_suggestions, 3);
});
test('successful save uses the resolved ID and excludes credentials', async () => {
  const t = setup(server({})); await t.api.load();
  await t.api.save({...t.api.get(),max_suggestions:8});
  assert.equal(t.api.get().max_suggestions, 8);
  const vars = t.requests.at(-1).body.variables;
  assert.equal(vars.plugin_id,'installed-face-plugin');
  assert.ok(!Object.keys(vars.input).some(k => k.endsWith('_api_key')));
});
test('relative URLs use the Stash origin and retain repeated query arguments', () => {
  const t = setup({}); const u = new URL(t.api.url('stashdb/performer',{alias:['a b','c'],empty:null}).href);
  assert.equal(u.origin,'https://stash.test'); assert.equal(u.pathname,'/face-api/stashdb/performer');
  assert.deepEqual(u.searchParams.getAll('alias'),['a b','c']); assert.equal(u.searchParams.has('empty'),false);
});
test('HTTP on an HTTPS page is rejected without guessing an HTTPS port', () => {
  const t=setup({}); t.api.set({...t.api.get(),api_url:'http://server.test:5000'});
  assert.match(t.api.url('recognize').error.message,/HTTPS/);
  for (const invalid of ['//evil.test','javascript:alert(1)','https://user:pass@server.test','/face-api?x=1']) assert.throws(() => t.api.normalize(invalid));
});
test('player mount changes are coalesced; unrelated DOM changes cause no work', () => {
  const t=setup({}); let count=0; t.api.mockMount(() => count++); t.api.observe();
  const node=match=>({nodeType:1,matches:()=>match,querySelector:()=>null});
  t.mutate([{addedNodes:[node(false)],removedNodes:[]}]); assert.equal(t.timers.length,0);
  for(let i=0;i<20;i++) t.mutate([{addedNodes:[node(true)],removedNodes:[]}]);
  assert.equal(t.timers.length,1); t.timers[0](); assert.equal(count,2);
});
