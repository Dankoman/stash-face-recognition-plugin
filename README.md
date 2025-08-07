# Stash Face Recognition Plugin v2.0

Ett avancerat plugin för Stash App som möjliggör ansiktsigenkänning direkt i videospelaren med automatisk performer-hantering. Pluginet kan pausa scener, extrahera bilder, visa identifierade ansikten som overlay och automatiskt lägga till performers till scenen.

## Nya funktioner i v2.0

- **Automatisk performer-tillägg**: Lägg till identifierade personer direkt till scenen
- **Performer-skapande**: Skapa nya performer-poster för okända ansikten
- **Bulk-tillägg**: Lägg till alla identifierade personer med en knapp
- **Interaktiva bounding boxes**: Klicka på "+" för att lägga till enskilda performers
- **Förbättrade inställningar**: Fler konfigurationsalternativ
- **Bättre felhantering**: Tydligare meddelanden och status-uppdateringar

## Funktioner

### Grundläggande funktioner
- **Pausning och bildextraktion**: Pausa video och extrahera aktuell frame
- **Ansiktsigenkänning**: Skicka bild till din befintliga face_extractor webtjänst
- **Visuell feedback**: Visa resultat som overlay med färgkodade bounding boxes
- **Konfigurerbar**: Anpassningsbara inställningar för API-URL, timeout och konfidensgrad

### Performer-hantering (NYT!)
- **Automatisk sökning**: Hitta befintliga performers baserat på namn
- **Automatisk skapande**: Skapa nya performer-poster för okända ansikten
- **Scen-integration**: Lägg automatiskt till performers till aktuell scen
- **Bulk-operationer**: Lägg till alla identifierade personer samtidigt
- **Manuell kontroll**: Välj individuellt vilka performers som ska läggas till

### Användargränssnitt
- **Interaktiva bounding boxes**: Klicka på "+" för att lägga till enskilda performers
- **Bulk-tillägg knapp**: Lägg till alla identifierade personer med en knapp
- **Statusmeddelanden**: Tydlig feedback om vad som händer
- **Responsiv design**: Fungerar på både desktop och mobila enheter

## Installation

### 1. Förbered din Face Extractor API

Använd den uppdaterade `api_endpoint.py` från v1.0 (ingen förändring behövs).

```bash
# Navigera till ditt face_extractor repo
cd /path/to/face_extractor

# Starta servern med API-stöd
python api_endpoint.py
```

### 2. Installera Plugin v2.0 i Stash

1. Ta backup av din befintliga plugin-mapp (om du har v1.0)
2. Kopiera hela `stash-face-recognition-plugin-v2` mappen till din Stash plugins-katalog
3. Starta om Stash App helt
4. Gå till **Settings > Plugins** och aktivera "Face Recognition Plugin"

### 3. Konfigurera Plugin

1. Gå till en video i Stash
2. Högerklicka på "Identifiera Ansikten"-knappen för att öppna inställningar
3. Konfigurera följande nya inställningar:

#### Grundläggande inställningar
- **API URL**: `http://192.168.0.140:5000` (din server-URL)
- **Timeout**: `30` sekunder
- **Minimum konfidensgrad**: `30` procent
- **Visa konfidensgrad**: ✓ (markerad)

#### Nya performer-inställningar
- **Lägg till performers automatiskt**: ✓ för automatisk tillägg
- **Skapa nya performers**: ✓ för att skapa nya poster för okända ansikten

## Användning

### Grundläggande ansiktsigenkänning

1. Öppna en video i Stash
2. Pausa videon vid önskad tidpunkt
3. Klicka på "Identifiera Ansikten"-knappen
4. Vänta medan bilden analyseras
5. Se resultatet som overlay med bounding boxes och namn

### Lägga till performers till scenen

#### Automatisk tillägg
Om "Lägg till performers automatiskt" är aktiverat, läggs alla identifierade personer automatiskt till scenen.

#### Manuell tillägg
1. Efter ansiktsigenkänning, klicka på "+" knappen på varje bounding box
2. Eller använd "Lägg till alla (X)" knappen för bulk-tillägg
3. Få bekräftelse när performers läggs till

#### Skapa nya performers
Om "Skapa nya performers" är aktiverat:
- Okända ansikten (som inte matchar befintliga performers) kan skapas som nya poster
- Nya performers får automatiskt namnet från ansiktsigenkänningen
- En beskrivning läggs till som indikerar att de skapades av pluginet

### Färgkodning

- **Grön**: Hög konfidensgrad (≥70%)
- **Gul**: Medium konfidensgrad (40-69%)
- **Röd**: Låg konfidensgrad (<40%)

### Inställningar

Högerklicka på plugin-knappen för att komma åt inställningar:

#### API-inställningar
- **API URL**: URL till din face_extractor tjänst
- **Timeout**: Maximal väntetid för API-anrop (sekunder)
- **Minimum konfidensgrad**: Filtrera bort resultat under denna procentsats
- **Visa konfidensgrad**: Visa/dölj procenttal i labels

#### Performer-inställningar
- **Lägg till performers automatiskt**: Lägg automatiskt till alla identifierade personer
- **Skapa nya performers**: Skapa nya performer-poster för okända ansikten

## GraphQL API-integration

Pluginet använder Stashs GraphQL API för performer-hantering:

### Sökfunktioner
- `findPerformers`: Söker efter befintliga performers baserat på namn
- `findScene`: Hämtar information om aktuell scen

### Mutationer
- `performerCreate`: Skapar nya performer-poster
- `sceneUpdate`: Uppdaterar scen med nya performers

### Exempel på GraphQL-anrop

```graphql
# Söka efter performer
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

# Skapa ny performer
mutation PerformerCreate($input: PerformerCreateInput!) {
  performerCreate(input: $input) {
    id
    name
  }
}

# Uppdatera scen med performers
mutation SceneUpdate($input: SceneUpdateInput!) {
  sceneUpdate(input: $input) {
    id
    performers {
      id
      name
    }
  }
}
```

## Felsökning

### Plugin visas inte i Stash

1. Kontrollera att `face-recognition.yml` har korrekt syntax
2. Verifiera att CSP-inställningarna inkluderar din API-URL
3. Starta om Stash helt
4. Kontrollera Stash-loggar för felmeddelanden

### API-anslutningsfel

1. Kontrollera att face_extractor servern körs
2. Verifiera API-URL i plugin-inställningar
3. Kontrollera CSP-inställningar i `face-recognition.yml`
4. Testa med längre timeout-värde

### Performer-tillägg fungerar inte

1. Kontrollera att du är på en scen-sida (URL innehåller `/scenes/[ID]`)
2. Verifiera att Stash GraphQL API är tillgängligt
3. Kontrollera webbläsarens konsol för GraphQL-fel
4. Testa att skapa performers manuellt i Stash först

### Inga ansikten hittas

1. Testa med bättre belysning/bildkvalitet
2. Pausa vid en annan tidpunkt i videon
3. Kontrollera att face_extractor modellen är korrekt laddad
4. Sänk minimum konfidensgrad i inställningar

## Säkerhet och behörigheter

### GraphQL API-åtkomst
Pluginet använder Stashs inbyggda GraphQL API utan att kräva separata API-nycklar. All kommunikation sker via webbläsarens session.

### Content Security Policy
CSP-inställningarna i `face-recognition.yml` tillåter anslutningar till:
- `http://192.168.0.140:5000` (din specifika server)
- `http://localhost:5000` (lokal utveckling)
- `http://127.0.0.1:5000` (alternativ lokal adress)

### Datahantering
- Inga bilder sparas permanent av pluginet
- Performer-data lagras endast i Stash-databasen
- API-anrop loggas i face_extractor servern

## Prestanda

### Optimeringar i v2.0
- Asynkrona GraphQL-anrop för bättre responsivitet
- Batch-operationer för bulk-tillägg av performers
- Förbättrad felhantering för robusthet
- Cachning av scen-information

### Prestandatips
- Använd "Lägg till alla" för snabbare bulk-operationer
- Aktivera "Automatisk tillägg" för smidigast arbetsflöde
- Justera timeout baserat på din nätverkshastighet
- Överväg att optimera face_extractor modellen för snabbare inferens

## Utveckling och anpassning

### Filstruktur

```
stash-face-recognition-plugin-v2/
├── face-recognition.yml      # Plugin-konfiguration med CSP
├── face-recognition.js       # Huvudfunktionalitet + GraphQL
├── face-recognition.css      # Styling för nya UI-element
└── README.md                # Denna fil
```

### Anpassning

Du kan anpassa pluginet genom att:

1. **Modifiera CSS** för olika utseende och animationer
2. **Ändra JavaScript** för ny funktionalitet eller andra API-endpoints
3. **Uppdatera GraphQL-queries** för andra datastrukturer
4. **Lägga till nya inställningar** i YAML-konfigurationen

### Debugging

Öppna webbläsarens utvecklarverktyg för att se:
- Console-loggar från plugin (`faceRecognitionPlugin`)
- GraphQL-anrop till Stash API
- Nätverkstrafik till face_extractor API
- Eventuella JavaScript- eller GraphQL-fel

### Globala funktioner

Pluginet exponerar följande funktioner för debugging:

```javascript
// Tillgängliga via window.faceRecognitionPlugin
performFaceRecognition()        // Kör ansiktsigenkänning
showSettings()                  // Visa inställningspanel
hideSettings()                  // Dölj inställningspanel
removeOverlay()                 // Ta bort overlay
addPerformerToCurrentScene(name) // Lägg till performer manuellt
getCurrentSceneId()             // Hämta aktuell scen-ID
identifiedFaces()               // Hämta senaste identifierade ansikten
```

## Changelog

### v2.0.0
- ✨ Ny: Automatisk performer-tillägg till scener
- ✨ Ny: Skapa nya performer-poster för okända ansikten
- ✨ Ny: Interaktiva bounding boxes med "+" knappar
- ✨ Ny: Bulk-tillägg knapp för alla identifierade personer
- ✨ Ny: GraphQL API-integration med Stash
- ✨ Ny: Förbättrade inställningar med performer-alternativ
- 🎨 Förbättrat: Modernare UI med animationer och hover-effekter
- 🐛 Fixat: Bättre felhantering och statusmeddelanden
- 📱 Förbättrat: Responsiv design för mobila enheter

### v1.0.0
- 🎉 Initial release med grundläggande ansiktsigenkänning
- 🎯 Overlay med bounding boxes och namn
- ⚙️ Konfigurerbar API-integration
- 🎨 Grundläggande CSS-styling

## Licens

Detta plugin är baserat på ditt befintliga face_extractor projekt och följer samma licens.

## Support

För support och buggrapporter:
1. Kontrollera denna dokumentation först
2. Testa med debugging-funktionerna
3. Skapa ett issue i ditt face_extractor repository
4. Inkludera webbläsarkonsol-loggar och Stash-version

