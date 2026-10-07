# Face Recognition Plugin 3.0.2

Fristående Stash-plugin med ansiktsanalys direkt i webbläsaren. ZIP-paketet innehåller JavaScript, WebAssembly, SCRFD/ArcFace-modeller och en paketerad igenkänningsdatabas. Ingen Go-tjänst, Pythoninstallation, CDN eller separat analysserver behövs för att använda pluginet.

## Användning

1. Öppna en scen och välj **Edit**. Identifiera-knappen visas enbart där.
2. Starta videon och pausa vid önskad bildruta.
3. Klicka **Identifiera**. För musen över ansiktsrutan för att visa resultatlistan med kandidatbilder och konfidens.
4. Välj ett förslag för att lägga till personen i scenen. Automatisk koppling och skapande av nya performers styrs av inställningarna.
5. Högerklicka på knappen för inställningar och **Testa analysmotor**.

Knappen visas inte på Details, andra scenflikar eller Settings. Ingen flytande knapp skapas. **Max förslag (topp-K)** styr antalet kandidater med varsin preview i listan. Förslag under **Minimum konfidens** visas med märkningen **Osäkert förslag**. Saknas en bild visas **Bild saknas**, och kandidaten går fortfarande att välja. Större förhandsbilder visas bredvid det aktiva förslaget och stängs vid val, avslutad hover, sidbyte eller när resultatet tas bort.

## Analys

En bakgrundsarbetare laddar modellerna från pluginets egna Stash-adresser. `auto` provar WebGPU och återgår till CPU/WebAssembly när en GPU saknas eller modellen inte fungerar på den. `cpu` tvingar CPU. Motortestet kör båda modellerna innan det rapporterar att motorn är redo. GPU:n på datorn med webbläsaren används. Samma paket används på Windows och Linux; GPU-stöd beror på webbläsare och drivrutiner.

De första anropen inkluderar modelladdning. Motorn återanvänds därefter, och timeout avbryter arbetaren för att frigöra resurser. Modellerna körs utan krav på SharedArrayBuffer, COOP/COEP, CUDA eller ROCm. Videobilden skickas inte till någon analysserver.

Matchning använder exporterade 512-dimensionella embeddings och cosinusavstånd, med samma viktade grannröstning och poängmappning som Go-versionen. Koordinater räknas tillbaka till originalbilden. Justeringen använder en likformighetstransform med samma referenspunkter; numeriskt identiska resultat med OpenCV/RANSAC utlovas inte.

## Metadata och bilder

Stashs egna GraphQL-uppslag används för konfigurerade Stash-box-källor: StashDB, ThePornDB, PMVStash och FansDB. API-nycklar begärs inte av pluginet. Konfigurera önskade källor under **Settings → Metadata Providers → Stash-Box Endpoints**; inga separata scrapers behöver installeras.

Välj **Alla** under Metadatakälla för sökordningen **StashDB → TPDB → PMVStash → FansDB**. Första entydiga träffen används och senare källor anropas inte. Ej konfigurerade källor hoppas över; ett källfel eller en tvetydig träff låter sökningen fortsätta till nästa källa. Om ingen entydig träff finns rapporteras källfelen. Övriga val använder den valda primärkällan först, följd av övriga konfigurerade källor. Exakta namn eller alias krävs. Befintliga personer matchas med sina sparade externa ID:n, så två personer med samma namn inte förväxlas. En person som redan finns i scenen kräver inget metadatauppslag. Tvetydiga träffar utan en sparad identitet stoppas. Ett källfel skiljs från en lyckad sökning utan träff, så ett fel inte skapar en person med enbart namn. De metadatafält som pluginet stöder och Stash accepterar vid import följer med. Bilder hämtas av Stash vid skapande/uppdatering, vilket undviker webbläsarens CORS-problem. Komplettering bevarar ifyllda lokala fält och kräver samma externa identitet.

## Installation

Se [INSTALLATION.md](INSTALLATION.md). Installera eller uppgradera via Stash med `main/index.yml` som plugin-källa. GitHub-versionen 3.0.2 innehåller det kompletta ZIP-paketet med modeller, runtime och igenkänningsdata.

## Verifiering

```sh
node --check face-recognition.js
node --check standalone-browser.js
node --check assets/recognition-worker.js
node --test tests/*.test.cjs
```

`tests/browser-smoke.html` kör de faktiska paketerade modellerna på syntetisk media, också med CSP som tillåter WebAssembly men inte allmän JavaScript-eval. `tests/ui-placement.html` verifierar knappens placering med Stashs observerade DOM-struktur. Testserver och Node/Python används bara under utveckling.

Verifierat i Chrome/Linux: modellerna körs på CPU, analys av pausad video fungerar, befintliga performers kan väljas utan tvetydiga namnsökningar och previewn placeras vid förslaget och tas bort efter valet. Knappen visas enbart i Edit. 64 automatiserade tester täcker även metadataimport, inställningar, arbetaren och fördröjd preview-laddning.

Windows, AMD/Nvidia-acceleration, bredare träffsäkerhet och full metadataimport mot livekällor är ännu inte verifierade. WebGPU-stöd beror på webbläsare och drivrutiner; CPU/WebAssembly används som fallback.
