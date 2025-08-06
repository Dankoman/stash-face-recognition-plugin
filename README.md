# Stash Face Recognition Plugin

Ett plugin för Stash App som möjliggör ansiktsigenkänning direkt i videospelaren. Pluginet kan pausa scener, extrahera bilder och visa identifierade ansikten som overlay med bounding boxes och namn.

## Funktioner

- **Pausning och bildextraktion**: Pausa video och extrahera aktuell frame
- **Ansiktsigenkänning**: Skicka bild till din befintliga face_extractor webtjänst
- **Visuell feedback**: Visa resultat som overlay med färgkodade bounding boxes
- **Konfigurerbar**: Anpassningsbara inställningar för API-URL, timeout och konfidensgrad
- **Responsiv design**: Fungerar på både desktop och mobila enheter

## Installation

### 1. Förbered din Face Extractor API

Först behöver du uppdatera din befintliga `face_extractor` för att stödja API-anrop från Stash:

```bash
# Navigera till ditt face_extractor repo
cd /path/to/face_extractor

# Kopiera den nya API-filen
cp /path/to/api_endpoint.py ./

# Installera CORS-stöd
pip install flask-cors

# Starta servern med API-stöd
python api_endpoint.py
```

### 2. Installera Plugin i Stash

1. Kopiera hela `stash-face-recognition-plugin` mappen till din Stash plugins-katalog
2. Öppna Stash och gå till **Settings > Plugins**
3. Klicka på **Available Plugins** och lägg till plugin-mappen
4. Aktivera "Face Recognition Plugin"

### 3. Konfigurera Plugin

1. Gå till en video i Stash
2. Högerklicka på "Identifiera Ansikten"-knappen för att öppna inställningar
3. Ange din API-URL (t.ex. `http://localhost:5000`)
4. Justera timeout och konfidensgrad efter behov
5. Spara inställningarna

## Användning

### Grundläggande användning

1. Öppna en video i Stash
2. Pausa videon vid önskad tidpunkt (eller låt pluginet pausa automatiskt)
3. Klicka på "Identifiera Ansikten"-knappen (överst till höger i videospelaren)
4. Vänta medan bilden analyseras
5. Se resultatet som overlay med bounding boxes och namn

### Färgkodning

- **Grön**: Hög konfidensgrad (≥70%)
- **Gul**: Medium konfidensgrad (40-69%)
- **Röd**: Låg konfidensgrad (<40%)

### Inställningar

Högerklicka på plugin-knappen för att komma åt inställningar:

- **API URL**: URL till din face_extractor tjänst
- **Timeout**: Maximal väntetid för API-anrop (sekunder)
- **Minimum konfidensgrad**: Filtrera bort resultat under denna procentsats
- **Visa konfidensgrad**: Visa/dölj procenttal i labels

## API-specifikation

### POST /api/detect

Skickar en bild för ansiktsigenkänning.

**Request:**
- Content-Type: `multipart/form-data`
- Body: `image` (fil)

**Response:**
```json
{
  "faces": [
    {
      "name": "John Doe",
      "confidence": 0.85,
      "bbox": [100, 150, 200, 250]
    }
  ],
  "image_width": 1920,
  "image_height": 1080,
  "total_faces": 1
}
```

### GET /api/health

Kontrollerar API-status.

**Response:**
```json
{
  "status": "ok",
  "service": "face_extractor",
  "version": "1.0.0",
  "model_loaded": true,
  "threshold": 0.2
}
```

## Felsökning

### Plugin visas inte

1. Kontrollera att plugin-filerna är i rätt mapp
2. Verifiera att `face-recognition.yml` har korrekt syntax
3. Starta om Stash

### API-fel

1. Kontrollera att face_extractor servern körs (`http://localhost:5000/api/health`)
2. Verifiera API-URL i plugin-inställningar
3. Kontrollera nätverksanslutning och CORS-inställningar

### Inga ansikten hittas

1. Kontrollera bildkvalitet och belysning
2. Justera konfidensgrad-inställningar
3. Testa med olika videotidpunkter

### Prestanda

- API-anrop kan ta 5-30 sekunder beroende på bildstorlek och modell
- Större bilder ger bättre noggrannhet men längre processtid
- Överväg att optimera din face_extractor modell för snabbare inferens

## Utveckling

### Filstruktur

```
stash-face-recognition-plugin/
├── face-recognition.yml      # Plugin-konfiguration
├── face-recognition.js       # Huvudfunktionalitet
├── face-recognition.css      # Styling
└── README.md                # Denna fil
```

### Anpassning

Du kan anpassa pluginet genom att:

1. Modifiera CSS för olika utseende
2. Ändra JavaScript för ny funktionalitet
3. Uppdatera API-endpoints för andra tjänster

### Debugging

Öppna webbläsarens utvecklarverktyg för att se:
- Console-loggar från plugin
- Nätverkstrafik till API
- Eventuella JavaScript-fel

## Licens

Detta plugin är baserat på ditt befintliga face_extractor projekt och följer samma licens.

## Support

För support och buggrapporter, skapa en issue i ditt face_extractor repository eller kontakta utvecklaren.

