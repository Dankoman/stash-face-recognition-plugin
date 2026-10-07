# Face Recognition Plugin 3.0.0-dev.3

Fristående Stash-plugin med ansiktsanalys direkt i webbläsaren. ZIP-paketet innehåller JavaScript, WebAssembly, SCRFD/ArcFace-modeller och din exporterade igenkänningsdatabas. Ingen Go-tjänst, Pythoninstallation, CDN eller separat analysserver behövs för att använda pluginet.

## Användning

1. Öppna en scen och välj **Edit**. Identifiera-knappen visas enbart där.
2. Starta videon och pausa vid önskad bildruta.
3. Klicka **Identifiera**. Resultat visas som överlägg med förslag och konfidens.
4. Välj ett förslag för att lägga till personen i scenen. Automatisk koppling och skapande av nya performers styrs av inställningarna.
5. Högerklicka på knappen för inställningar och **Testa analysmotor**.

Knappen visas inte på Details, andra scenflikar eller Settings. Ingen flytande knapp skapas.

## Analys

En bakgrundsarbetare laddar modellerna från pluginets egna Stash-adresser. `auto` provar WebGPU och återgår till CPU/WebAssembly när en GPU saknas eller modellen inte fungerar på den. `cpu` tvingar CPU. Motortestet kör båda modellerna innan det rapporterar att motorn är redo. GPU:n på datorn med webbläsaren används. Samma paket används på Windows och Linux; GPU-stöd beror på webbläsare och drivrutiner.

De första anropen inkluderar modelladdning. Motorn återanvänds därefter, och timeout avbryter arbetaren för att frigöra resurser. Modellerna körs utan krav på SharedArrayBuffer, COOP/COEP, CUDA eller ROCm. Videobilden skickas inte till någon analysserver.

Matchning använder exporterade 512-dimensionella embeddings och cosinusavstånd, med samma viktade grannröstning och poängmappning som Go-versionen. Koordinater räknas tillbaka till originalbilden. Justeringen använder en likformighetstransform med samma referenspunkter; numeriskt identiska resultat med OpenCV/RANSAC utlovas inte.

## Metadata och bilder

Stashs egna GraphQL-uppslag används för konfigurerade Stash-box-källor: StashDB, ThePornDB, PMVStash och FansDB. API-nycklar begärs inte av pluginet. Konfigurera önskade källor under **Settings → Metadata Providers → Stash-Box Endpoints**; inga separata scrapers behöver installeras.

Primärkällan provas först, följd av övriga konfigurerade källor. Exakta namn eller alias krävs. Tvetydiga träffar stoppas. Ett källfel skiljs från en lyckad sökning utan träff, så ett fel inte skapar en person med enbart namn. Alla fält som Stash exponerar genom `ScrapedPerformer` och accepterar vid import följer med. Bilder hämtas av Stash vid skapande/uppdatering, vilket undviker webbläsarens CORS-problem. Komplettering bevarar ifyllda lokala fält och kräver samma externa identitet.

## Installation

Se [INSTALLATION.md](INSTALLATION.md). Det lokala experimentpaketet finns i `dist/face-recognition-3.0.0-dev.3.zip`. Det vanliga `index.yml` och gamla ZIP-arkivet är fortfarande för den stabila 2.4.2-versionen; använd experimentpaketet för denna gren.

## Verifiering

```sh
node --check face-recognition.js
node --check standalone-browser.js
node --check assets/recognition-worker.js
node --test tests/*.test.cjs
```

`tests/browser-smoke.html` kör de faktiska paketerade modellerna på syntetisk media, också med CSP som tillåter WebAssembly men inte allmän JavaScript-eval. `tests/ui-placement.html` verifierar knappens placering med Stashs observerade DOM-struktur. Testserver och Node/Python används bara under utveckling.

Lokalt verifierat i Chrome/Linux: båda modellerna laddas och körs på CPU, tom bild returnerar inga ansikten, knappen finns enbart i Edit. Den aktuella Chrome-sessionen erbjöd ingen användbar WebGPU-adapter. Windows, AMD/Nvidia-acceleration, träffsäkerhet på riktiga scener och metadataimport mot dina livekällor återstår att verifiera innan versionen är färdig för normal drift.
