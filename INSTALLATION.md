# Installation Guide - Stash Face Recognition Plugin v2.0

Denna guide hjälper dig att installera och konfigurera Face Recognition Plugin v2.0 för Stash App.

## Förutsättningar

### 1. Stash App
- Stash App installerat och fungerande
- Tillgång till Stash plugins-katalog
- Administratörsbehörigheter för att starta om Stash

### 2. Face Extractor API
- Ditt befintliga face_extractor repository
- Python-miljö med nödvändiga dependencies
- Tränad modell för ansiktsigenkänning

## Steg 1: Förbered Face Extractor API

### 1.1 Uppdatera API-endpoint (om du använder v1.0)

Om du redan har v1.0 av pluginet installerat, behöver du inte uppdatera `api_endpoint.py` - den fungerar med v2.0.

Om du inte har API-endpointen än, använd filen från det ursprungliga plugin-paketet.

### 1.2 Starta Face Extractor servern

```bash
# Navigera till ditt face_extractor repository
cd /path/to/face_extractor

# Aktivera din Python-miljö (om du använder virtual environment)
source venv/bin/activate  # Linux/macOS
# eller
venv\Scripts\activate     # Windows

# Starta servern
python api_endpoint.py
```

Servern bör starta på `http://localhost:5000` eller din konfigurerade adress.

### 1.3 Testa API-endpointen

```bash
# Testa att API:et svarar
curl http://localhost:5000/api/health

# Förväntat svar: {"status": "ok"}
```

## Steg 2: Installera Plugin v2.0

### 2.1 Hitta Stash plugins-katalog

Stash plugins-katalogen finns vanligtvis på:

**Windows:**
```
%APPDATA%\stash\plugins\
```

**macOS:**
```
~/Library/Application Support/stash/plugins/
```

**Linux:**
```
~/.stash/plugins/
```

**Docker:**
```
/config/plugins/  (inuti containern)
```

### 2.2 Backup befintlig plugin (om du har v1.0)

```bash
# Backup av befintlig plugin
mv /path/to/stash/plugins/stash-face-recognition-plugin /path/to/stash/plugins/stash-face-recognition-plugin-v1-backup
```

### 2.3 Kopiera nya plugin-filer

```bash
# Kopiera hela plugin-mappen till Stash plugins-katalog
cp -r /path/to/stash-face-recognition-plugin-v2 /path/to/stash/plugins/

# Alternativt, byt namn för att matcha v1.0 strukturen
mv /path/to/stash/plugins/stash-face-recognition-plugin-v2 /path/to/stash/plugins/stash-face-recognition-plugin
```

### 2.4 Verifiera filstruktur

Din plugins-katalog bör nu se ut så här:

```
plugins/
└── stash-face-recognition-plugin/
    ├── face-recognition.yml
    ├── face-recognition.js
    ├── face-recognition.css
    ├── README.md
    └── INSTALLATION.md
```

## Steg 3: Konfigurera Content Security Policy

### 3.1 Uppdatera CSP-inställningar

Öppna `face-recognition.yml` och uppdatera CSP-sektionen med din API-URL:

```yaml
ui:
  csp:
    connect-src:
      - http://192.168.0.140:5000  # <-- Ändra till din API-URL
      - http://localhost:5000
      - http://127.0.0.1:5000
```

**Viktigt:** Ersätt `192.168.0.140:5000` med den faktiska IP-adressen och porten där din face_extractor API körs.

### 3.2 Spara och validera YAML

Kontrollera att YAML-syntaxen är korrekt:

```bash
# Testa YAML-syntax (om du har python installerat)
python -c "import yaml; yaml.safe_load(open('face-recognition.yml'))"
```

## Steg 4: Starta om Stash

### 4.1 Stäng Stash helt

- Stäng webbläsarflikar med Stash
- Stoppa Stash-processen/service
- Vänta några sekunder

### 4.2 Starta Stash igen

- Starta Stash-applikationen
- Vänta tills den är helt laddad
- Öppna Stash i webbläsaren

## Steg 5: Aktivera Plugin i Stash

### 5.1 Navigera till Plugin-inställningar

1. Öppna Stash i webbläsaren
2. Gå till **Settings** (Inställningar)
3. Klicka på **Plugins**

### 5.2 Hitta och aktivera plugin

1. Leta efter "Face Recognition Plugin" i listan
2. Om den inte visas, klicka på "Reload Plugins" eller "Check for Updates"
3. Aktivera pluginet med växlingsknappen eller "Install"-knappen

### 5.3 Verifiera installation

Du bör se:
- Plugin-namn: "Face Recognition Plugin"
- Version: "2.0.0"
- Status: "Enabled" eller "Active"

## Steg 6: Konfigurera Plugin-inställningar

### 6.1 Navigera till en video

1. Gå till **Scenes** i Stash
2. Öppna en video
3. Leta efter "Identifiera Ansikten"-knappen (vanligtvis i övre högra hörnet av videospelaren)

### 6.2 Öppna plugin-inställningar

1. **Högerklicka** på "Identifiera Ansikten"-knappen
2. Inställningspanelen bör öppnas

### 6.3 Konfigurera grundläggande inställningar

**API URL:**
```
http://192.168.0.140:5000
```
(Ersätt med din faktiska API-URL)

**Timeout (sekunder):**
```
30
```

**Minimum konfidensgrad (%):**
```
30
```

**Visa konfidensgrad:**
```
✓ (markerad)
```

### 6.4 Konfigurera nya performer-inställningar

**Lägg till performers automatiskt:**
```
✓ (markerad för automatisk tillägg)
```

**Skapa nya performers:**
```
✓ (markerad för att skapa nya poster)
```

### 6.5 Spara inställningar

Klicka på "Spara"-knappen i inställningspanelen.

## Steg 7: Testa Installation

### 7.1 Grundläggande test

1. Pausa en video vid en punkt där ansikten syns
2. Klicka på "Identifiera Ansikten"-knappen
3. Vänta på analys (loading-indikator bör visas)
4. Kontrollera att bounding boxes visas över identifierade ansikten

### 7.2 Testa performer-tillägg

1. Efter ansiktsigenkänning, klicka på "+" knappen på en bounding box
2. Kontrollera att ett bekräftelsemeddelande visas
3. Gå till scen-informationen och verifiera att performern lades till

### 7.3 Testa bulk-tillägg

1. Om flera ansikten identifieras, klicka på "Lägg till alla (X)"-knappen
2. Kontrollera att alla performers läggs till scenen

## Felsökning

### Plugin visas inte i Stash

**Problem:** Plugin dyker inte upp i Settings > Plugins

**Lösningar:**
1. Kontrollera filsökvägar och behörigheter
2. Validera YAML-syntax i `face-recognition.yml`
3. Starta om Stash helt
4. Kontrollera Stash-loggar för felmeddelanden

### CSP-fel i webbläsaren

**Problem:** "Refused to connect" fel i browser console

**Lösningar:**
1. Uppdatera CSP-inställningar i `face-recognition.yml`
2. Lägg till din exakta API-URL i `connect-src` listan
3. Starta om Stash efter CSP-ändringar
4. Kontrollera att API-URL:en är korrekt

### API-anslutningsfel

**Problem:** Plugin kan inte ansluta till face_extractor API

**Lösningar:**
1. Kontrollera att face_extractor servern körs
2. Testa API-URL:en manuellt i webbläsaren
3. Kontrollera brandväggsinställningar
4. Verifiera nätverksanslutning mellan Stash och API-server

### GraphQL-fel

**Problem:** Fel vid tillägg av performers till scener

**Lösningar:**
1. Kontrollera att du är på en scen-sida (URL innehåller `/scenes/[ID]`)
2. Testa att skapa performers manuellt i Stash först
3. Kontrollera webbläsarens konsol för specifika GraphQL-fel
4. Verifiera Stash-version kompatibilitet

### Prestanda-problem

**Problem:** Långsam respons eller timeout

**Lösningar:**
1. Öka timeout-värdet i plugin-inställningar
2. Optimera face_extractor modellen
3. Kontrollera nätverkshastighet
4. Minska bildkvalitet om möjligt

## Avancerad konfiguration

### Anpassad API-endpoint

Om du använder en annan API-struktur, kan du modifiera `face-recognition.js`:

```javascript
// Ändra API-endpoint URL
const response = await fetch(`${pluginSettings.api_url}/custom/detect`, {
    // ... resten av konfigurationen
});
```

### Anpassad styling

Modifiera `face-recognition.css` för att ändra utseende:

```css
/* Ändra färger för bounding boxes */
.face-recognition-box.high-confidence {
    border-color: #your-color; /* Anpassad färg */
}
```

### Anpassade GraphQL-queries

Modifiera GraphQL-queries i `face-recognition.js` för andra datastrukturer:

```javascript
// Exempel: Lägg till fler fält i performer-sökning
const query = `
    query FindPerformers($filter: String) {
        findPerformers(
            performer_filter: { name: { value: $filter, modifier: EQUALS } }
            filter: { per_page: 1 }
        ) {
            performers {
                id
                name
                aliases
                birthdate
            }
        }
    }
`;
```

## Support och underhåll

### Loggar och debugging

**Stash-loggar:**
- Kontrollera Stash-applikationens loggar för plugin-relaterade fel
- Vanligtvis i `~/.stash/stash.log` eller liknande

**Webbläsarkonsol:**
- Öppna Developer Tools (F12)
- Kontrollera Console-fliken för JavaScript-fel
- Kontrollera Network-fliken för API-anrop

**Face Extractor loggar:**
- Kontrollera terminal/konsol där face_extractor körs
- Leta efter HTTP-anrop och eventuella fel

### Uppdateringar

För framtida uppdateringar:
1. Backup befintlig plugin-mapp
2. Ersätt med nya filer
3. Uppdatera konfiguration vid behov
4. Starta om Stash

### Backup och återställning

**Backup:**
```bash
# Backup av plugin-mapp
cp -r /path/to/stash/plugins/stash-face-recognition-plugin /path/to/backup/

# Backup av inställningar (lagras i webbläsaren)
# Exportera från plugin-inställningar eller använd webbläsarens utvecklarverktyg
```

**Återställning:**
```bash
# Återställ plugin-mapp
cp -r /path/to/backup/stash-face-recognition-plugin /path/to/stash/plugins/
```

## Slutsats

Efter att ha följt denna guide bör du ha:

✅ Face Recognition Plugin v2.0 installerat och aktiverat i Stash
✅ API-anslutning konfigurerad och fungerande
✅ Performer-tillägg funktionalitet aktiverad
✅ Plugin-inställningar anpassade efter dina behov

Om du stöter på problem, kontrollera felsökningssektionen eller skapa ett issue i ditt face_extractor repository med detaljerad information om problemet.

