// face-recognition.js

// Huvudlogik för att köra ansiktsigenkänning via face_extractor API och visa resultat i Stash overlay
// Nu uppdaterad med stöd för profilbilder från lokal Stash och/eller StashDB samt inställning för antal förslag

(async function() {
  const settings = await stash.getPluginSettings();

  async function recognizeFrame(imageBlob) {
    const url = `${settings.api_url}/recognize?top_k=${settings.max_suggestions || 3}`;
    const resp = await fetch(url, { method: 'POST', body: imageBlob });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    return await resp.json();
  }

  async function queryLocalStashImage(name) {
    const gql = `
      query FindPerformerImage($name: String!) {
        findPerformers(
          performer_filter: {
            OR: {
              name: { value: $name, modifier: EQUALS },
              aliases: { value: $name, modifier: EQUALS }
            }
          }
          filter: { per_page: 1 }
        ) {
          performers {
            image_path
            images { url }
          }
        }
      }
    `;
    const res = await stash.callGQL(gql, { name });
    const perf = res?.findPerformers?.performers?.[0];
    return perf?.image_path || perf?.images?.[0]?.url || null;
  }

  async function queryStashDBImage(name) {
    if (!settings.stashdb_endpoint || !settings.stashdb_api_key) return null;
    const gql = `
      query FindPerformerOnStashBox($q: String!) {
        queryPerformers(input: { q: $q, page: 1, per_page: 1 }) {
          performers {
            images { url }
          }
        }
      }
    `;
    const resp = await fetch(settings.stashdb_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'APIKey': settings.stashdb_api_key
      },
      body: JSON.stringify({ query: gql, variables: { q: name } })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const perf = data?.data?.queryPerformers?.performers?.[0];
    return perf?.images?.[0]?.url || null;
  }

  async function resolvePerformerImage(name) {
    let localUrl = null;
    let stashdbUrl = null;

    if (settings.image_source === 'local' || settings.image_source === 'both') {
      localUrl = await queryLocalStashImage(name);
      if (localUrl) return localUrl;
    }

    if (settings.image_source === 'stashdb' || settings.image_source === 'both') {
      stashdbUrl = await queryStashDBImage(name);
      if (stashdbUrl) return stashdbUrl;
    }

    return null;
  }

  function renderOverlay(result) {
    const container = document.createElement('div');
    container.className = 'frp-overlay';

    result.forEach(face => {
      const faceBox = document.createElement('div');
      faceBox.className = 'frp-face-box';
      faceBox.style.left = `${face.box.x}px`;
      faceBox.style.top = `${face.box.y}px`;
      faceBox.style.width = `${face.box.w}px`;
      faceBox.style.height = `${face.box.h}px`;

      const suggestions = document.createElement('div');
      suggestions.className = 'frp-suggestions';

      face.candidates.forEach(async cand => {
        if (cand.score * 100 < settings.min_confidence) return;
        const row = document.createElement('div');
        row.className = 'frp-suggestion';

        const img = document.createElement('img');
        img.className = 'frp-avatar';
        img.src = await resolvePerformerImage(cand.name) || '';

        const label = document.createElement('span');
        label.textContent = settings.show_confidence
          ? `${cand.name} (${Math.round(cand.score * 100)}%)`
          : cand.name;

        row.appendChild(img);
        row.appendChild(label);
        suggestions.appendChild(row);
      });

      faceBox.appendChild(suggestions);
      container.appendChild(faceBox);
    });

    document.body.appendChild(container);
  }

  // Exempel: hämta en frame och kör
  // const frameBlob = ...;
  // const result = await recognizeFrame(frameBlob);
  // renderOverlay(result);
})();