# Face Recognition Plugin 2.4

Plugin för Stash med analys av den aktuella videobilden, förslag i bildöverlägg och möjlighet att lägga till en vald performer i scenen.

## Drift

```text
Webbläsare → Stashs HTTPS-adress /face-api/ → StashAPI (Go)
                          ↘ Stash kontrollerar inloggningen
```

Pluginet använder normalt `/face-api`. Samma domän, certifikat och session som Stash används, utan en separat publik API-adress. Go-tjänsten kör analysen och hämtar metadata/bilder. En annan explicit HTTP(S)-adress kan fortfarande konfigureras; HTTP från en HTTPS-sida avvisas med ett tydligt fel.

## Användning

1. Öppna en scen och välj en bildruta i videon.
2. Klicka **Identifiera**. Knappen visar **Analyserar…** under anropet.
3. Välj ett förslag i bildöverlägget för att lägga till det i scenen.
4. Högerklicka på knappen för inställningar. **Testa anslutning** kontrollerar den sparade API-adressen utan att skicka en videobild.

Inställningar sparas i Stash. Panelen och Stashs pluginsida redigerar samma värden. Sidan behöver laddas om efter ändringar från Stashs pluginsida. Ett misslyckat sparande stänger inte panelen och ändrar inte den aktiva konfigurationen.

API-nycklar finns endast på API-servern. Pluginet lagrar eller skickar inga metadata-nycklar i webbläsarens localStorage eller API-adresser.

## Installation och uppdatering

Se [INSTALLATION.md](INSTALLATION.md). Paketet består av `face-recognition.js`, `face-recognition.css` och `face-recognition.yml`. `index.yml` innehåller version och SHA-256 för ZIP-arkivet.

## Ändringar i 2.4

- Samma adress och inloggning som Stash via `/face-api`.
- Stash är enda källa för inställningarna; gammal lokal cache tas bort efter lyckad inläsning.
- Metadata-nycklar hanteras på servern.
- Ingen återkommande timer som söker igenom sidan. Relevanta förändringar vid videospelaren samlas till en uppdatering.
- Bildcachen begränsas till 64 poster och töms när inställningarna ändras.
- Anslutningstest, tydlig pågående-status, skydd mot dubbelklick och meddelande vid tomma resultat.
- API:t får `raw_faces=1`; pluginet använder sin egen konfidensgräns.

## Verifiering

```sh
node --check face-recognition.js
node tests/settings.test.cjs
node tests/recognition-ui.test.cjs
```

Testerna använder syntetisk media och ett simulerat API. De kontrollerar inställningar, sparfel, URL-hantering, samlade DOM-uppdateringar, dubbelklick, tomma svar och nätverksfel.
