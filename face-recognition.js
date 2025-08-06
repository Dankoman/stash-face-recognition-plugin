(function() {
    'use strict';

    // Plugin-konfiguration
    const PLUGIN_ID = 'face-recognition';
    let pluginSettings = {
        api_url: 'http://localhost:5000',
        api_timeout: 30,
        show_confidence: true,
        min_confidence: 30
    };

    // Plugin-tillstånd
    let isProcessing = false;
    let currentOverlay = null;
    let settingsPanel = null;

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

    // Skapa bounding box för ett ansikte
    function createBoundingBox(face, containerWidth, containerHeight) {
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
        
        // Skapa label
        const label = document.createElement('div');
        label.className = 'face-recognition-label';
        
        let labelText = face.name;
        if (pluginSettings.show_confidence) {
            labelText += ` (${confidence.toFixed(1)}%)`;
        }
        label.textContent = labelText;
        
        box.appendChild(label);
        
        return box;
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
        
        // Skapa bounding boxes
        filteredFaces.forEach(face => {
            const box = createBoundingBox(face, results.image_width, results.image_height);
            currentOverlay.appendChild(box);
        });
        
        // Auto-remove overlay efter 10 sekunder
        setTimeout(() => {
            removeOverlay();
        }, 10000);
    }

    // Ta bort overlay
    function removeOverlay() {
        if (currentOverlay) {
            currentOverlay.remove();
            currentOverlay = null;
        }
    }

    // Visa meddelande
    function showMessage(message, type = 'info') {
        const messageEl = document.createElement('div');
        messageEl.className = `face-recognition-${type === 'error' ? 'error' : 'loading'}`;
        messageEl.textContent = message;
        
        document.body.appendChild(messageEl);
        
        setTimeout(() => {
            messageEl.remove();
        }, 3000);
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
        
        saveSettings();
        hideSettings();
        showMessage('Inställningar sparade', 'info');
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
            removeOverlay
        };
    }

    // Starta plugin
    initPlugin();

})();

