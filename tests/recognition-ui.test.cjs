const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the real click handler with synthetic media and a mocked API.
const source = fs.readFileSync(path.join(__dirname, '..', 'face-recognition.js'), 'utf8');
const entrypoint = "init().catch(e => console.error('Initfel:', e));";
assert.ok(source.includes(entrypoint));

function setup({ response = [], fetchError, readyState = 4, blob = new Blob(['synthetic']) } = {}) {
  const notifications = [];
  const requests = [];
  const label = { textContent: 'Identifiera' };
  const button = {
    disabled: false,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector: () => label,
  };
  const video = { readyState, videoWidth: 128, videoHeight: 128 };
  let releaseRequest;
  const pendingRequest = new Promise(resolve => { releaseRequest = resolve; });
  const context = {
    URL, AbortController, Blob, File, FormData,
    console: { error() {}, warn() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    window: { location: { protocol: 'https:', origin: 'https://stash.example.test' }, addEventListener() {} },
    document: {
      querySelector: () => video,
      querySelectorAll: selector => selector === '.frp-fab' ? [button] : [],
      createElement(tag) {
        if (tag === 'canvas') return {
          getContext: () => ({ drawImage() {} }),
          toBlob: callback => callback(blob),
        };
        return { style: {}, remove() {} };
      },
      body: { appendChild: element => notifications.push(element.textContent) },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      await pendingRequest;
      if (fetchError) throw fetchError;
      return { ok: true, json: async () => response };
    },
  };
  vm.runInNewContext(source.replace(entrypoint, 'globalThis.runRecognition = performFaceRecognition;'), context);
  return { run: context.runRecognition, button, label, notifications, requests, releaseRequest };
}

test('a pending request shows progress, blocks duplicate clicks, and reports an empty result', async () => {
  const ui = setup();
  const pending = ui.run();
  await Promise.resolve();
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.attributes['aria-busy'], 'true');
  assert.equal(ui.label.textContent, 'Analyserar…');
  await ui.run();
  assert.equal(ui.requests.length, 1);
  const url = new URL(ui.requests[0].url);
  assert.equal(url.searchParams.get('raw_faces'), '1');
  assert.equal(url.searchParams.get('top_k'), '3');
  assert.equal(ui.requests[0].options.body.get('image').name, 'frame.jpg');
  ui.releaseRequest();
  await pending;
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.button.attributes['aria-busy'], 'false');
  assert.equal(ui.label.textContent, 'Identifiera');
  assert.match(ui.notifications.at(-1), /Inga ansikten hittades/);
});

test('a failed request reports its error and restores the button', async () => {
  const ui = setup({ fetchError: new Error('Failed to fetch') });
  ui.releaseRequest();
  await ui.run();
  assert.equal(ui.button.disabled, false);
  assert.match(ui.notifications.at(-1), /Failed to fetch/);
});

test('an unexpected API response is reported instead of being treated as an empty result', async () => {
  const ui = setup({ response: { error: 'unexpected response' } });
  ui.releaseRequest();
  await ui.run();
  assert.equal(ui.button.disabled, false);
  assert.match(ui.notifications.at(-1), /ogiltigt svar/);
});

test('a video without a decoded frame is not sent to the API', async () => {
  const ui = setup({ readyState: 1 });
  await ui.run();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.notifications.at(-1), /Video ej redo/);
});

test('failure to capture a frame restores the button without sending a request', async () => {
  const ui = setup({ blob: null });
  await ui.run();
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.notifications.at(-1), /Kunde inte skapa bild/);
});
