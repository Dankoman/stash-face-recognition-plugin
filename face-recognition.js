(function() {
    'use strict';

    // Plugin-konfiguration
    const PLUGIN_ID = 'face-recognition';
    let pluginSettings = {
        api_url: 'http://localhost:5000',
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
                throw new Error(`GraphQL request failed: ${response.status}`);
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

    // Sök efter befintlig performer baserat på namn
    async function findPerformerByName(name) {
        const query = `
            query FindPerformers($filter: String) {
                findPerformers(
                    performer_filter: { name: { value: $filter, modifier: EQUALS } }
                    filter: { per_page: 1 }
                ) {
                    performers {
                        id
                        name
                    }
                }
            }
        `;

        try {
            const data = await stashGraphQL(query, { filter: name });
            return data.findPerformers.performers.length > 0 ? data.findPerformers.performers[0] : null;
        } catch (error) {
            console.error('Error finding performer:', error);
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
            
            // Om performer inte finns och vi ska skapa nya
            if (!performer && pluginSettings.create_new_performers) {
                performer = await createPerformer(performerName);
                showMessage(`Skapade ny performer: ${performerName}`, 'success');
            }
            
            if (!performer) {
                throw new Error(`Performer "${performerName}" hittades inte och skapande av nya performers är inaktiverat`);
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
            showMessage(`Fel vid tillägg av ${performerName}: ${error.message}`, 'error');
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

        try {
            const response = await fetch(`${pluginSettings.api_url}/api/detect`, {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`API-fel: ${response.status} ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('API-anrop timeout');
            }
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
        const knownFaces = filteredFaces.filter(face => face.name !== 'UNKNOWN');
        if (knownFaces.length > 1) {
            createBulkAddButton(knownFaces);
        }
        
        // Auto-remove overlay efter 15 sekunder
        setTimeout(() => {
            removeOverlay();
        }, 15000);
    }

    // Skapa knapp för att lägga till alla identifierade personer
    function createBulkAddButton(knownFaces) {
        const bulkButton = document.createElement('button');
        bulkButton.className = 'face-recognition-bulk-button';
        bulkButton.textContent = `Lägg till alla (${knownFaces.length})`;
        bulkButton.onclick = () => {
            const sceneId = getCurrentSceneId();
            if (sceneId) {
                knownFaces.forEach(face => {
                    addPerformerToScene(face.name, sceneId);
                });
            }
        };
        
        // Positionera knappen
        bulkButton.style.position = 'absolute';
        bulkButton.style.bottom = '10px';
        bulkButton.style.right = '10px';
        bulkButton.style.background = '#28a745';
        bulkButton.style.color = 'white';
        bulkButton.style.border = 'none';
        bulkButton.style.borderRadius = '5px';
        bulkButton.style.padding = '8px 16px';
        bulkButton.style.cursor = 'pointer';
        bulkButton.style.fontSize = '14px';
        bulkButton.style.pointerEvents = 'auto';
        bulkButton.style.zIndex = '1003';
        
        currentOverlay.appendChild(bulkButton);
    }

    // Ta bort overlay
    function removeOverlay() {
        if (currentOverlay) {
            currentOverlay.remove();
            currentOverlay = null;
        }
        identifiedFaces = [];
    }

    // Visa meddelande
    function showMessage(message, type = 'info') {
        const messageEl = document.createElement('div');
        messageEl.className = `face-recognition-message face-recognition-${type}`;
        messageEl.textContent = message;
        
        // Styling baserat på typ
        const styles = {
            info: { background: '#17a2b8', color: 'white' },
            success: { background: '#28a745', color: 'white' },
            error: { background: '#dc3545', color: 'white' }
        };
        
        const style = styles[type] || styles.info;
        Object.assign(messageEl.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '10px 20px',
            borderRadius: '5px',
            zIndex: '1004',
            maxWidth: '300px',
            fontSize: '14px',
            ...style
        });
        
        document.body.appendChild(messageEl);
        
        setTimeout(() => {
            messageEl.remove();
        }, 4000);
    }

    // Visa loading-indikator
    function showLoading() {
        const loading = document.createElement('div');
        loading.className = 'face-recognition-loading';
        loading.innerHTML = `
            <div class="face-recognition-spinner"></div>
            <div>Analyserar ansikten...</div>
        `;
        
        document.body.appendChild(loading);
        return loading;
    }

    // Huvudfunktion för ansiktsigenkänning
    async function performFaceRecognition() {
        if (isProcessing) {
            return;
        }
        
        isProcessing = true;
        const loading = showLoading();
        
        try {
            // Hitta video och container
            const container = findVideoContainer();
            if (!container) {
                throw new Error('Kunde inte hitta video-container');
            }
            
            // Hämta aktuell scen-ID
            currentSceneId = getCurrentSceneId();
            if (!currentSceneId) {
                console.warn('Kunde inte hitta scen-ID, performer-tillägg kommer inte att fungera');
            }
            
            // Pausa video
            const video = findVideoElement();
            if (video && !video.paused) {
                video.pause();
            }
            
            // Extrahera frame
            const canvas = captureVideoFrame();
            const imageBlob = await canvasToBlob(canvas);
            
            // Skicka till API
            const results = await sendImageToAPI(imageBlob);
            
            // Visa resultat
            displayResults(results, container);
            
        } catch (error) {
            console.error('Face recognition error:', error);
            showMessage(`Fel: ${error.message}`, 'error');
        } finally {
            loading.remove();
            isProcessing = false;
        }
    }

    // Skapa inställningspanel
    function createSettingsPanel() {
        const panel = document.createElement('div');
        panel.className = 'face-recognition-settings';
        panel.innerHTML = `
            <h4>Face Recognition Inställningar</h4>
            <label>API URL:</label>
            <input type="text" id="fr-api-url" value="${pluginSettings.api_url}">
            
            <label>Timeout (sekunder):</label>
            <input type="number" id="fr-timeout" value="${pluginSettings.api_timeout}" min="5" max="120">
            
            <label>Minimum konfidensgrad (%):</label>
            <input type="number" id="fr-min-confidence" value="${pluginSettings.min_confidence}" min="0" max="100">
            
            <label>
                <input type="checkbox" id="fr-show-confidence" ${pluginSettings.show_confidence ? 'checked' : ''}>
                Visa konfidensgrad
            </label>
            
            <label>
                <input type="checkbox" id="fr-auto-add" ${pluginSettings.auto_add_performers ? 'checked' : ''}>
                Lägg till performers automatiskt
            </label>
            
            <label>
                <input type="checkbox" id="fr-create-new" ${pluginSettings.create_new_performers ? 'checked' : ''}>
                Skapa nya performers för okända ansikten
            </label>
            
            <div>
                <button class="save-btn" onclick="window.faceRecognitionPlugin.saveSettingsFromPanel()">Spara</button>
                <button class="cancel-btn" onclick="window.faceRecognitionPlugin.hideSettings()">Avbryt</button>
            </div>
        `;
        
        document.body.appendChild(panel);
        return panel;
    }

    // Visa inställningar
    function showSettings() {
        if (settingsPanel) {
            hideSettings();
        }
        settingsPanel = createSettingsPanel();
    }

    // Dölj inställningar
    function hideSettings() {
        if (settingsPanel) {
            settingsPanel.remove();
            settingsPanel = null;
        }
    }

    // Spara inställningar från panel
    function saveSettingsFromPanel() {
        if (!settingsPanel) return;
        
        pluginSettings.api_url = document.getElementById('fr-api-url').value;
        pluginSettings.api_timeout = parseInt(document.getElementById('fr-timeout').value);
        pluginSettings.min_confidence = parseInt(document.getElementById('fr-min-confidence').value);
        pluginSettings.show_confidence = document.getElementById('fr-show-confidence').checked;
        pluginSettings.auto_add_performers = document.getElementById('fr-auto-add').checked;
        pluginSettings.create_new_performers = document.getElementById('fr-create-new').checked;
        
        saveSettings();
        hideSettings();
        showMessage('Inställningar sparade', 'success');
    }

    // Skapa plugin-knapp
    function createPluginButton() {
        const button = document.createElement('button');
        button.className = 'face-recognition-button';
        button.textContent = 'Identifiera Ansikten';
        button.onclick = performFaceRecognition;
        
        // Lägg till högerklick för inställningar
        button.oncontextmenu = (e) => {
            e.preventDefault();
            showSettings();
        };
        
        return button;
    }

    // Lägg till plugin-knapp till video-container
    function addPluginButton() {
        const container = findVideoContainer();
        if (!container) return;
        
        // Kontrollera om knappen redan finns
        if (container.querySelector('.face-recognition-button')) return;
        
        const button = createPluginButton();
        container.appendChild(button);
    }

    // Initiera plugin
    function initPlugin() {
        loadSettings();
        
        // Lägg till knapp när sidan laddas
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', addPluginButton);
        } else {
            addPluginButton();
        }
        
        // Observera DOM-ändringar för att lägga till knapp på nya sidor
        const observer = new MutationObserver(() => {
            setTimeout(addPluginButton, 1000);
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        // Exponera funktioner globalt för debugging
        window.faceRecognitionPlugin = {
            performFaceRecognition,
            showSettings,
            hideSettings,
            saveSettingsFromPanel,
            removeOverlay,
            addPerformerToCurrentScene,
            getCurrentSceneId,
            identifiedFaces: () => identifiedFaces
        };
    }

    // Starta plugin
    initPlugin();

})();

