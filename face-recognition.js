(function() {
    'use strict';

    // Plugin-konfiguration
    const PLUGIN_ID = 'face-recognition';
    let pluginSettings = {
        api_url: 'http://192.168.0.140:5000',
        api_timeout: 30,
        show_confidence: true,
        min_confidence: 30,
        auto_add_performers: false,
        create_new_performers: false
    };

    // Plugin-tillstånd
    let isProcessing = false;
    let currentOverlay = null;
    let settingsPanel = null;
    let currentSceneId = null;
    let identifiedFaces = [];

    // Ladda plugin-inställningar
    function loadSettings() {
        try {
            const saved = localStorage.getItem(`${PLUGIN_ID}_settings`);
            if (saved) {
                pluginSettings = { ...pluginSettings, ...JSON.parse(saved) };
            }
        } catch (e) {
            console.warn('Kunde inte ladda plugin-inställningar:', e);
        }
    }

    // Spara plugin-inställningar
    function saveSettings() {
        try {
            localStorage.setItem(`${PLUGIN_ID}_settings`, JSON.stringify(pluginSettings));
        } catch (e) {
            console.warn('Kunde inte spara plugin-inställningar:', e);
        }
    }

    // Hämta aktuell scen-ID från URL
    function getCurrentSceneId() {
        const path = window.location.pathname;
        const match = path.match(/\/scenes\/(\d+)/);
        return match ? match[1] : null;
    }

    // GraphQL API-anrop till Stash
    async function stashGraphQL(query, variables = {}) {
        try {
            const response = await fetch('/graphql', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: query,
                    variables: variables
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`GraphQL request failed: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const result = await response.json();
            
            if (result.errors) {
                throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(', ')}`);
            }

            return result.data;
        } catch (error) {
            console.error('Stash GraphQL error:', error);
            throw error;
        }
    }

// Sök performer på namn eller alias (två steg)
async function findPerformerByName(name) {
    /* --- 1) exakt match på fältet name ----------------------------------- */
    const qName = /* GraphQL */ `
      query FindByName($v:String!) {
        findPerformers(
          performer_filter:{ name:{ value:$v, modifier:EQUALS } }
          filter:{ per_page:1 }
        ){
          performers { id name }
        }
      }`.trim();

    try {
        // försök med name
        let data = await stashGraphQL(qName, { v: name });
        if (data.findPerformers.performers.length)
            return data.findPerformers.performers[0];

        /* --- 2) ingen träff – prova exakt match på fältet alias ------------- */
        const qAlias = /* GraphQL */ `
          query FindByAlias($v:String!){
            findPerformers(
              performer_filter:{ aliases:{ value:$v, modifier:EQUALS } }
              filter:{ per_page:1 }
            ){
              performers { id name }
            }
          }`.trim();

        data = await stashGraphQL(qAlias, { v: name });
        return data.findPerformers.performers[0] ?? null;

    } catch (e) {
        console.error('Error finding performer:', e);
        return null;
    }
}



    // Skapa ny performer
    async function createPerformer(name) {
        const mutation = `
            mutation PerformerCreate($input: PerformerCreateInput!) {
                performerCreate(input: $input) {
                    id
                    name
                }
            }
        `;

        try {
            const data = await stashGraphQL(mutation, {
                input: {
                    name: name,
                    details: `Automatiskt skapad av Face Recognition Plugin`
                }
            });
            return data.performerCreate;
        } catch (error) {
            console.error('Error creating performer:', error);
            throw error;
        }
    }

    // Hämta aktuell scen-information
    async function getSceneInfo(sceneId) {
        const query = `
            query FindScene($id: ID!) {
                findScene(id: $id) {
                    id
                    title
                    performers {
                        id
                        name
                    }
                }
            }
        `;

        try {
            const data = await stashGraphQL(query, { id: sceneId });
            return data.findScene;
        } catch (error) {
            console.error('Error getting scene info:', error);
            throw error;
        }
    }

    // Uppdatera scen med nya performers
    async function updateScenePerformers(sceneId, performerIds) {
        const mutation = `
            mutation SceneUpdate($input: SceneUpdateInput!) {
                sceneUpdate(input: $input) {
                    id
                    performers {
                        id
                        name
                    }
                }
            }
        `;

        try {
            const data = await stashGraphQL(mutation, {
                input: {
                    id: sceneId,
                    performer_ids: performerIds
                }
            });
            return data.sceneUpdate;
        } catch (error) {
            console.error('Error updating scene performers:', error);
            throw error;
        }
    }

    // Lägg till performer till scen
    async function addPerformerToScene(performerName, sceneId) {
        try {
            // Först, försök hitta befintlig performer
            let performer = await findPerformerByName(performerName);
            
            // Om performer inte hittades
            if (!performer) {
                if (pluginSettings.create_new_performers) {
                    try {
                        performer = await createPerformer(performerName);
                        showMessage(`Skapade ny performer: ${performerName}`, 'success');
                    } catch (createError) {
                        // Specifik hantering för om skapandet misslyckas (t.ex. pga race condition)
                        if (createError.message.includes('already exists')) {
                            showMessage(`Performer '${performerName}' skapades av annan process, försöker hitta igen.`, 'info');
                            performer = await findPerformerByName(performerName); // Försök hitta igen
                            if (!performer) {
                                throw new Error(`Kunde inte hitta eller skapa performer '${performerName}'.`);
                            }
                        } else {
                            throw createError; // Annat fel vid skapande
                        }
                    }
                } else {
                    throw new Error(`Performer '${performerName}' hittades inte och skapande av nya performers är inaktiverat.`);
                }
            }

            // Hämta aktuella performers för scenen
            const sceneInfo = await getSceneInfo(sceneId);
            const currentPerformerIds = sceneInfo.performers.map(p => p.id);
            
            // Kontrollera om performer redan är kopplad till scenen
            if (currentPerformerIds.includes(performer.id)) {
                showMessage(`${performerName} är redan kopplad till denna scen`, 'info');
                return;
            }

            // Lägg till ny performer till listan
            const updatedPerformerIds = [...currentPerformerIds, performer.id];
            
            // Uppdatera scenen
            await updateScenePerformers(sceneId, updatedPerformerIds);
            showMessage(`Lade till ${performerName} till scenen`, 'success');
            
        } catch (error) {
            console.error('Error adding performer to scene:', error);
            showMessage(`Fel vid tillägg av performer: ${error.message}`, 'error');
        }
    }

    // Hitta video-elementet på sidan
    function findVideoElement() {
        return document.querySelector('video') || document.querySelector('.video-js video');
    }

    // Hitta video-containern
    function findVideoContainer() {
        const video = findVideoElement();
        if (!video) return null;
        
        // Försök hitta den närmaste containern som har position relative/absolute
        let container = video.parentElement;
        while (container && container !== document.body) {
            const style = window.getComputedStyle(container);
            if (style.position === 'relative' || style.position === 'absolute') {
                return container;
            }
            container = container.parentElement;
        }
        
        // Fallback till video-elementets förälder
        return video.parentElement;
    }

    // Extrahera aktuell frame från video som canvas
    function captureVideoFrame() {
        const video = findVideoElement();
        if (!video) {
            throw new Error('Ingen video hittades på sidan');
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        canvas.width = video.videoWidth || video.clientWidth;
        canvas.height = video.videoHeight || video.clientHeight;
        
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        return canvas;
    }

    // Konvertera canvas till blob
    function canvasToBlob(canvas) {
        return new Promise((resolve) => {
            canvas.toBlob(resolve, 'image/jpeg', 0.8);
        });
    }

    // Skicka bild till API för ansiktsigenkänning
    async function sendImageToAPI(imageBlob) {
        const formData = new FormData();
        formData.append('image', imageBlob, 'frame.jpg');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), pluginSettings.api_timeout * 1000);

        const apiUrl = `${pluginSettings.api_url}/api/detect`;
        console.log(`[Face Recognition Plugin] Skickar bild till API: ${apiUrl}`);

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API-fel: ${response.status} ${response.statusText} - ${errorText}`);
            }

            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('API-anrop timeout');
            }
            console.error('[Face Recognition Plugin] Fel vid API-anrop:', error);
            throw error;
        }
    }

    // Skapa overlay för att visa resultat
    function createOverlay(container) {
        const overlay = document.createElement('div');
        overlay.className = 'face-recognition-overlay';
        container.appendChild(overlay);
        return overlay;
    }

    // Skapa bounding box för ett ansikte med interaktiva knappar
    function createBoundingBox(face, containerWidth, containerHeight, index) {
        const box = document.createElement('div');
        box.className = 'face-recognition-box';
        
        // Beräkna position och storlek relativt till container
        const left = (face.bbox[0] / containerWidth) * 100;
        const top = (face.bbox[1] / containerHeight) * 100;
        const width = ((face.bbox[2] - face.bbox[0]) / containerWidth) * 100;
        const height = ((face.bbox[3] - face.bbox[1]) / containerHeight) * 100;
        
        box.style.left = `${left}%`;
        box.style.top = `${top}%`;
        box.style.width = `${width}%`;
        box.style.height = `${height}%`;
        
        // Sätt färg baserat på konfidensgrad
        const confidence = face.confidence * 100;
        if (confidence >= 70) {
            box.classList.add('high-confidence');
        } else if (confidence >= 40) {
            box.classList.add('medium-confidence');
        } else {
            box.classList.add('low-confidence');
        }
        
        // Skapa label med namn och konfidensgrad
        const label = document.createElement('div');
        label.className = 'face-recognition-label';
        
        let labelText = face.name;
        if (pluginSettings.show_confidence) {
            labelText += ` (${confidence.toFixed(1)}%)`;
        }
        label.textContent = labelText;
        
        // Skapa knapp för att lägga till performer (endast för kända ansikten)
        if (face.name !== 'UNKNOWN') {
            const addButton = document.createElement('button');
            addButton.className = 'face-recognition-add-button';
            addButton.textContent = '+';
            addButton.title = `Lägg till ${face.name} till scenen`;
            addButton.onclick = (e) => {
                e.stopPropagation();
                addPerformerToCurrentScene(face.name);
            };
            
            // Positionera knappen i övre högra hörnet av bounding box
            addButton.style.position = 'absolute';
            addButton.style.top = '2px';
            addButton.style.right = '2px';
            addButton.style.width = '20px';
            addButton.style.height = '20px';
            addButton.style.fontSize = '12px';
            addButton.style.background = '#007bff';
            addButton.style.color = 'white';
            addButton.style.border = 'none';
            addButton.style.borderRadius = '50%';
            addButton.style.cursor = 'pointer';
            addButton.style.pointerEvents = 'auto';
            
            box.appendChild(addButton);
        }
        
        box.appendChild(label);
        
        return box;
    }

    // Lägg till performer till aktuell scen
    async function addPerformerToCurrentScene(performerName) {
        const sceneId = getCurrentSceneId();
        if (!sceneId) {
            showMessage('Kunde inte hitta scen-ID', 'error');
            return;
        }

        try {
            await addPerformerToScene(performerName, sceneId);
        } catch (error) {
            console.error('Error adding performer to scene:', error);
            showMessage(`Fel vid tillägg av performer: ${error.message}`, 'error');
        }
    }

    // Visa resultat som overlay
    function displayResults(results, container) {
        // Ta bort befintligt overlay
        removeOverlay();
        
        if (!results.faces || results.faces.length === 0) {
            showMessage('Inga ansikten hittades', 'info');
            return;
        }
        
        // Skapa nytt overlay
        currentOverlay = createOverlay(container);
        
        // Filtrera ansikten baserat på minimum konfidensgrad
        const filteredFaces = results.faces.filter(face => 
            (face.confidence * 100) >= pluginSettings.min_confidence
        );
        
        if (filteredFaces.length === 0) {
            showMessage(`Inga ansikten över ${pluginSettings.min_confidence}% konfidensgrad`, 'info');
            removeOverlay();
            return;
        }
        
        // Spara identifierade ansikten för senare användning
        identifiedFaces = filteredFaces;
        
        // Skapa bounding boxes
        filteredFaces.forEach((face, index) => {
            const box = createBoundingBox(face, results.image_width, results.image_height, index);
            currentOverlay.appendChild(box);
        });
        
        // Automatiskt lägg till performers om inställningen är aktiverad
        if (pluginSettings.auto_add_performers) {
            const sceneId = getCurrentSceneId();
            if (sceneId) {
                const knownFaces = filteredFaces.filter(face => face.name !== 'UNKNOWN');
                knownFaces.forEach(face => {
                    addPerformerToScene(face.name, sceneId);
                });
            }
        }
        
        // Skapa bulk-tillägg knapp om det finns flera kända ansikten
        if (identifiedFaces.filter(face => face.name !== 'UNKNOWN').length > 1) {
            const bulkAddButton = document.createElement('button');
            bulkAddButton.className = 'face-recognition-bulk-add-button';
            bulkAddButton.textContent = 'Lägg till alla kända ansikten';
            bulkAddButton.onclick = () => {
                identifiedFaces.filter(face => face.name !== 'UNKNOWN').forEach(face => {
                    addPerformerToCurrentScene(face.name);
                });
            };
            currentOverlay.appendChild(bulkAddButton);
        }
    }

    // Ta bort overlay
    function removeOverlay() {
        if (currentOverlay) {
            currentOverlay.remove();
            currentOverlay = null;
        }
    }

    // Visa meddelanden till användaren
    function showMessage(message, type = 'info') {
        const existingMessage = document.querySelector('.face-recognition-message');
        if (existingMessage) {
            existingMessage.remove();
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = `face-recognition-message face-recognition-message-${type}`;
        msgDiv.textContent = message;
        document.body.appendChild(msgDiv);

        setTimeout(() => {
            msgDiv.remove();
        }, 5000);
    }

    // Skapa inställningspanel
    function createSettingsPanel() {
        if (settingsPanel) {
            settingsPanel.remove();
        }

        settingsPanel = document.createElement('div');
        settingsPanel.className = 'face-recognition-settings-panel';
        settingsPanel.innerHTML = `
            <h3>Ansiktsigenkänning Inställningar</h3>
            <label>
                API URL:
                <input type="text" id="api_url_input" value="${pluginSettings.api_url}">
            </label>
            <label>
                API Timeout (sekunder):
                <input type="number" id="api_timeout_input" value="${pluginSettings.api_timeout}">
            </label>
            <label>
                <input type="checkbox" id="show_confidence_checkbox" ${pluginSettings.show_confidence ? 'checked' : ''}>
                Visa konfidensgrad
            </label>
            <label>
                Minimum konfidensgrad (0-100):
                <input type="number" id="min_confidence_input" value="${pluginSettings.min_confidence}" min="0" max="100">
            </label>
            <label>
                <input type="checkbox" id="auto_add_performers_checkbox" ${pluginSettings.auto_add_performers ? 'checked' : ''}>
                Lägg till performers automatiskt
            </label>
            <label>
                <input type="checkbox" id="create_new_performers_checkbox" ${pluginSettings.create_new_performers ? 'checked' : ''}>
                Skapa nya performers för okända ansikten
            </label>
            <button id="save_settings_button">Spara Inställningar</button>
            <button id="close_settings_button">Stäng</button>
        `;

        document.body.appendChild(settingsPanel);

        document.getElementById('save_settings_button').onclick = () => {
            pluginSettings.api_url = document.getElementById('api_url_input').value;
            pluginSettings.api_timeout = parseInt(document.getElementById('api_timeout_input').value, 10);
            pluginSettings.show_confidence = document.getElementById('show_confidence_checkbox').checked;
            pluginSettings.min_confidence = parseInt(document.getElementById('min_confidence_input').value, 10);
            pluginSettings.auto_add_performers = document.getElementById('auto_add_performers_checkbox').checked;
            pluginSettings.create_new_performers = document.getElementById('create_new_performers_checkbox').checked;
            saveSettings();
            showMessage('Inställningar sparade!', 'success');
            settingsPanel.remove();
            settingsPanel = null;
        };

        document.getElementById('close_settings_button').onclick = () => {
            settingsPanel.remove();
            settingsPanel = null;
        };
    }

    // Skapa huvudknappen
    function createPluginButton() {
        const button = document.createElement('button');
        button.id = 'face-recognition-button';
        button.className = 'plugin-button';
        button.textContent = 'Ansiktsigenkänning';
        button.onclick = async () => {
            if (isProcessing) {
                showMessage('Bearbetar redan, vänligen vänta.', 'info');
                return;
            }
            isProcessing = true;
            showMessage('Startar ansiktsigenkänning...', 'info');
            removeOverlay();

            try {
                const videoContainer = findVideoContainer();
                if (!videoContainer) {
                    throw new Error('Kunde inte hitta videocontainer.');
                }

                const canvas = captureVideoFrame();
                const imageBlob = await canvasToBlob(canvas);
                const results = await sendImageToAPI(imageBlob);
                displayResults(results, videoContainer);
                showMessage('Ansiktsigenkänning klar!', 'success');
            } catch (error) {
                console.error('Fel vid ansiktsigenkänning:', error);
                showMessage(`Fel: ${error.message}`, 'error');
            } finally {
                isProcessing = false;
            }
        };

        // Skapa inställningsknapp
        const settingsButton = document.createElement('button');
        settingsButton.id = 'face-recognition-settings-button';
        settingsButton.className = 'plugin-button';
        settingsButton.textContent = 'Inställningar';
        settingsButton.onclick = () => {
            createSettingsPanel();
        };

        // Lägg till knapparna till Stash UI
        const pluginBar = document.querySelector('.plugin-bar');
        if (pluginBar) {
            pluginBar.appendChild(button);
            pluginBar.appendChild(settingsButton);
        } else {
            console.warn('Kunde inte hitta .plugin-bar elementet. Knapparna läggs till body istället.');
            document.body.appendChild(button);
            document.body.appendChild(settingsButton);
        }
    }

    // Initiera plugin
    function initializePlugin() {
        loadSettings();
        createPluginButton();
        // Lyssna på navigationsändringar för att återskapa knappen om nödvändigt
        window.addEventListener('popstate', () => {
            // Ge Stash tid att rendera om sidan
            setTimeout(() => {
                if (!document.getElementById('face-recognition-button')) {
                    createPluginButton();
                }
            }, 500);
        });
    }

    // Kör initiering när DOM är laddad
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializePlugin);
    } else {
        initializePlugin();
    }
})();