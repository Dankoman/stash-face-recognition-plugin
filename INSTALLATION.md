# Installationsguide - Stash Face Recognition Plugin

Denna guide hjälper dig att installera och konfigurera Face Recognition Plugin för Stash App.

## Förutsättningar

- Stash App installerat och konfigurerat
- Ditt befintliga `face_extractor` projekt
- Python 3.7+ med nödvändiga dependencies
- Webbläsare med JavaScript aktiverat

## Steg 1: Förbered Face Extractor API

### 1.1 Uppdatera ditt befintliga projekt

```bash
# Navigera till ditt face_extractor repo
cd /path/to/face_extractor

# Backup av befintlig app.py (valfritt)
cp app.py app.py.backup

# Kopiera den nya API-filen
# (Ersätt sökvägen med var du sparade api_endpoint.py)
cp /path/to/api_endpoint.py ./
```

### 1.2 Installera CORS-stöd

```bash
# Installera flask-cors för att tillåta cross-origin requests
pip install flask-cors
```

### 1.3 Testa API:et

```bash
# Starta servern med API-stöd
python api_endpoint.py
```

Du bör se utskrift som:
```
🚀 Startar Face Extractor API...
📊 Modell: arcface_work-ppic/face_knn_arcface_ppic.pkl
🎯 Threshold: 0.2
👥 Klasser: [antal klasser]
🌐 API-endpoints:
   POST /api/detect - Ansiktsigenkänning
   GET  /api/health - Hälsokontroll
   GET  /api/config - Hämta konfiguration
   POST /api/config - Uppdatera konfiguration
📱 Webbgränssnitt: http://localhost:5000
```

### 1.4 Verifiera API-funktionalitet

Öppna en ny terminal och testa:

```bash
# Testa hälsokontroll
curl http://localhost:5000/api/health

# Du bör få ett JSON-svar som:
# {"status":"ok","service":"face_extractor","version":"1.0.0",...}
```

## Steg 2: Installera Plugin i Stash

### 2.1 Hitta Stash plugins-katalog

Stash plugins lagras vanligtvis i:
- **Windows**: `%APPDATA%\stash\plugins\`
- **macOS**: `~/Library/Application Support/stash/plugins/`
- **Linux**: `~/.stash/plugins/`

Eller kontrollera i Stash under **Settings > Configuration > Paths**.

### 2.2 Kopiera plugin-filer

```bash
# Kopiera hela plugin-mappen till Stash plugins-katalog
cp -r /path/to/stash-face-recognition-plugin /path/to/stash/plugins/

# Alternativt, skapa symbolisk länk (Linux/macOS)
ln -s /path/to/stash-face-recognition-plugin /path/to/stash/plugins/face-recognition
```

### 2.3 Verifiera filstruktur

Din plugins-katalog bör nu innehålla:
```
plugins/
└── stash-face-recognition-plugin/
    ├── face-recognition.yml
    ├── face-recognition.js
    ├── face-recognition.css
    ├── README.md
    └── INSTALLATION.md
```

## Steg 3: Aktivera Plugin i Stash

### 3.1 Öppna Stash webbgränssnitt

Navigera till din Stash-installation (vanligtvis `http://localhost:9999`).

### 3.2 Gå till Plugin-inställningar

1. Klicka på **Settings** (kugghjulsikon)
2. Välj **Plugins** i sidomenyn
3. Klicka på **Available Plugins**

### 3.3 Lägg till plugin

1. Klicka på **Add Source** eller **Reload Plugins**
2. Du bör se "Face Recognition Plugin" i listan
3. Klicka på **Install** eller aktivera plugin-switchen

### 3.4 Konfigurera plugin-inställningar

1. Hitta "Face Recognition Plugin" i plugin-listan
2. Klicka på **Settings** eller kugghjulsikonen
3. Ange följande inställningar:
   - **API URL**: `http://localhost:5000` (eller din server-URL)
   - **API Timeout**: `30` (sekunder)
   - **Minimum konfidensgrad**: `30` (procent)
   - **Visa konfidensgrad**: ✓ (markerad)

## Steg 4: Testa Plugin

### 4.1 Öppna en video

1. Navigera till en video i ditt Stash-bibliotek
2. Klicka för att öppna videospelaren

### 4.2 Använd plugin

1. Du bör se en blå knapp "Identifiera Ansikten" i övre högra hörnet av videospelaren
2. Pausa videon vid en punkt där ansikten syns tydligt
3. Klicka på "Identifiera Ansikten"-knappen
4. Vänta medan bilden analyseras (loading-indikator visas)
5. Resultat visas som färgkodade bounding boxes över ansikten

### 4.3 Testa inställningar

1. Högerklicka på "Identifiera Ansikten"-knappen
2. Inställningspanelen öppnas
3. Testa att ändra API-URL eller konfidensgrad
4. Klicka "Spara" för att tillämpa ändringar

## Felsökning

### Plugin visas inte i Stash

**Problem**: Plugin syns inte i Available Plugins-listan.

**Lösningar**:
1. Kontrollera att `face-recognition.yml` finns och har korrekt syntax
2. Verifiera filbehörigheter (läsbar för Stash-processen)
3. Starta om Stash helt
4. Kontrollera Stash-loggar för felmeddelanden

### Plugin-knapp visas inte på videosidor

**Problem**: Knappen "Identifiera Ansikten" syns inte.

**Lösningar**:
1. Kontrollera att plugin är aktiverat i Settings > Plugins
2. Ladda om sidan (Ctrl+F5 eller Cmd+Shift+R)
3. Öppna webbläsarens utvecklarverktyg och leta efter JavaScript-fel
4. Testa på en annan video

### API-anslutningsfel

**Problem**: "API-fel" eller "Timeout" meddelanden.

**Lösningar**:
1. Kontrollera att face_extractor servern körs:
   ```bash
   curl http://localhost:5000/api/health
   ```
2. Verifiera API-URL i plugin-inställningar
3. Kontrollera brandväggsinställningar
4. Testa med längre timeout-värde

### Inga ansikten hittas

**Problem**: "Inga ansikten hittades" trots synliga ansikten.

**Lösningar**:
1. Testa med bättre belysning/bildkvalitet
2. Pausa vid en annan tidpunkt i videon
3. Kontrollera att face_extractor modellen är korrekt laddad
4. Sänk minimum konfidensgrad i inställningar

### Prestanda-problem

**Problem**: Plugin är långsamt eller hänger sig.

**Lösningar**:
1. Öka timeout-värdet i inställningar
2. Optimera face_extractor modellen
3. Använd mindre videoupplösning
4. Kontrollera systemresurser (CPU/RAM)

## Avancerad konfiguration

### Anpassa API-URL för fjärrserver

Om din face_extractor körs på en annan server:

```yaml
# I plugin-inställningar
API URL: http://192.168.1.100:5000
```

Säkerställ att servern lyssnar på alla interfaces:
```python
# I api_endpoint.py
app.run(host='0.0.0.0', port=5000, debug=False)
```

### Anpassa utseende

Redigera `face-recognition.css` för att ändra:
- Färger på bounding boxes
- Fontstorlek på labels
- Knapp-styling
- Overlay-transparens

### Debugging

Aktivera utvecklarverktyg i webbläsaren:
1. Tryck F12 eller högerklicka > "Inspect"
2. Gå till Console-fliken
3. Leta efter meddelanden från `faceRecognitionPlugin`
4. Kontrollera Network-fliken för API-anrop

## Support

Om du stöter på problem:

1. Kontrollera denna guide igen
2. Verifiera att alla förutsättningar är uppfyllda
3. Testa varje komponent separat (API, plugin, Stash)
4. Samla felmeddelanden från webbläsarkonsolen och Stash-loggar
5. Skapa ett issue i ditt face_extractor repository med detaljerad information

## Nästa steg

När pluginet fungerar kan du:
- Träna din modell med fler ansikten för bättre noggrannhet
- Anpassa CSS för personligt utseende
- Utöka funktionalitet med fler API-endpoints
- Integrera med andra Stash-plugins

