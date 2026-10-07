# Installation av 3.0-experimentet

## Komplett pluginpaket

1. Säkerhetskopiera den installerade pluginmappen och dess inställningar.
2. Packa upp `dist/face-recognition-3.0.0-dev.1.zip` i den befintliga `face-recognition`-pluginmappen. Behåll `assets/` och dess underkataloger; de innehåller alla analysfiler.
3. Klicka **Reload plugins** i Stash och ladda om webbläsarsidan.
4. Öppna en scen, välj **Edit**, högerklicka **Identifiera** och välj **Testa analysmotor**.
5. Kontrollera analysen på en pausad bildruta och att det inte finns någon Identifiera-knapp på Details eller Settings.

Ingen extern process startas av pluginet. `/face-api` används inte. Tidigare API URL-inställning ignoreras. Befintliga funktionella inställningar behålls; den gamla API-timeouten ersätts vid första inläsning med 180 sekunder eftersom modellerna nu laddas i webbläsaren.

Metadata behöver de källor du vill använda under Stashs **Settings → Metadata Providers → Stash-Box Endpoints**. Befintliga nycklar i StashAPI:s miljöfil migreras inte automatiskt till Stash. Pluginet läser inga nycklar och fungerar för analys utan externa metadatakällor. Källornas vanliga konton/nycklar behövs fortfarande för extern metadata.

## Uppdatering och återställning

Byt hela pluginpaketet, ladda om plugins och webbsidan efter en uppdatering. Igenkänningsdatabasen är en ögonblicksbild i paketet: nya träningsresultat behöver paketeras som en uppdatering. Pluginet läser inte en levande Python-pickle eller Go-exportkatalog på servern.

Återställ den säkerhetskopierade pluginmappen och inställningarna för att återgå till 2.4.2. Den befintliga Go-tjänsten har inte ändrats av detta experiment.

## Bygga paketet (enbart utvecklare)

Python och npm behövs bara på byggdatorn. Slutanvändaren installerar ZIP-paketet.

- Hämta `onnxruntime-web@1.24.3` från npm med `npm pack`.
- Lägg `ort.webgpu.bundle.min.mjs`, båda `ort-wasm-simd-threaded.jsep.*`, båda `ort-wasm-simd-threaded.asyncify.*` samt ONNX Runtimes MIT-licens i `assets/runtime/`.
- Lägg `det_10g.onnx` och `w600k_r50.onnx` från befintlig buffalo_l-installation i `assets/models/`.
- Lägg `embeddings.bin` och `labels.json` från din befintliga export i `assets/gallery/`.
- Kör `python tools/build-package.py`. Valfria flaggor: `--models`, `--gallery`, `--runtime`, `--output`.

Byggaren verifierar databasens storlek, skapar en filmanifest med SHA-256, kontrollerar ZIP-integriteten och skriver en separat checksumma. Genererade modeller, privat igenkänningsdata, runtimefiler och paket ignoreras av Git. Koden och byggaren ligger i experimentgrenen.

## Felsökning

- **Pluginfil saknas:** installera hela ZIP-innehållet inklusive `assets/`.
- **Modellstart/CSP-fel:** kontrollera att pluginets CSP laddats efter Reload plugins. WebAssembly behöver `wasm-unsafe-eval`; arbetaren behöver `worker-src 'self'`.
- **Långsam analys:** motortestet visar aktiv backend. CPU fungerar utan extra program men kan vara långsammare än GPU.
- **Metadatakälla saknas:** konfigurera Stash-box i Stash, inte i Go-tjänsten.
- **Tomma resultat:** testa en tydligare pausad bildruta; en tom bild ger en tom resultatlista.

Experimentet är ännu inte verifierat på Windows, AMD/Nvidia-GPU eller med full metadataimport i den aktiva Stash-installationen.
