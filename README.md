# Helsingin meluilmoituskartta

Karttapalvelu Helsingin meluilmoituspäätösten selaamiseen. Näyttää valitulta ajanjaksolta,
missä tehdään meluavaa louhintaa, rakennus- tai ratatyötä ja missä järjestetään meluavia
ulkoilmatapahtumia.

**[Avaa meluilmoituskartta](https://esiivola.github.io/helsinki-meluilmoitukset/)**

## Mitä palvelu näyttää

- Meluilmoituspäätökset kartalla valitulle ajanjaksolle, oletuksena seuraavat 7 vuorokautta
- Pikavalinnat ajanjaksolle: tänään, seuraavat 7 tai 30 vuorokautta, tämä vuosi — sekä oma ajanjakso
- Saman sijainnin kaikki ilmoitukset listana
- Voimassaoloaika, päätöksen salliman melutyön päivittäiset kellonajat ja ilmoittaja
- Suora linkki alkuperäiseen päätökseen
- Suodatus melun tyypin mukaan ja suomen- ja englanninkielinen käyttöliittymä

### Melun tyypit

Ilmoitus luokitellaan päätöksen otsikon kuvaaman toiminnan perusteella. Sama ilmoitus
voi kuulua useaan luokkaan — noin neljännes päätöksistä sallii monta eri melutyyppiä —
joten suodattimien lukumäärien summa on suurempi kuin ilmoitusten määrä.

Louhinta ja räjäytys · Murskaus ja iskuvasarointi · Paalutus ja pontitus · Poraus ·
Purku ja saneeraus · Rata- ja kiskotyö · Vesirakentaminen · Maa- ja katutyöt ·
Tapahtumat ja konsertit · Muu

Kartalla merkin väri kertoo ilmoituksen määräävimmän luokan; kaikki luokat näkyvät
ilmoituksen tiedoissa.

Tiedot on poimittu automaattisesti päätösteksteistä. Ajanjaksot ja sijainnit voivat olla
epätarkkoja — tarkista aina alkuperäinen päätös.

## Miten se toimii

Palvelussa on kaksi osaa.

**Kerääjä** (`scripts/`) hakee meluilmoituspäätökset Helsingin kaupungin päätöshaun
avoimesta hakurajapinnasta, poimii teksteistä ajanjakson, työajat, ilmoittajan ja melun
tyypin sekä paikantaa kohteen kaupungin avoimista osoite-, nimistö- ja aluerekistereistä.
Tulos kirjoitetaan arkistoon (`data/decisions.json`) ja julkaistaan selaimelle vuosittain
paloiteltuna (`public/data/`).

**Karttasovellus** (`src/main.jsx`) lukee vain valmiit JSON-tiedostot. Käynnistyessään se
lataa hakemiston ja kuluvan jakson; menneiden vuosien palat haetaan vasta jos käyttäjä
selaa niihin. Sovelluksella ei ole ajonaikaista rajapintariippuvuutta.

GitHub Actions ajaa kerääjän päivittäin ja nimistön uudelleenrakennuksen kuukausittain.
Päivittäinen ajo tuottaa aina commitin, mikä pitää ajastetun työnkulun aktiivisena — GitHub
poistaa ajastukset käytöstä julkisessa repositoriossa 60 päivän käyttämättömyyden jälkeen.

## Tietolähteet

- [Helsingin kaupungin päätökset](https://paatokset.hel.fi/) — meluilmoituspäätökset
- Helsingin kaupungin avoin paikkatieto (WFS): osoiteluettelo, nimistö, kaupunginosa- ja
  osa-aluejako
- Taustakartta © OpenStreetMap, © CARTO

## Paikallinen kehitys

Edellytyksenä on Node.js 22.

```bash
npm ci
npm run dev
```

Testit ja tuotantoversio:

```bash
npm test
npm run build
```

Aineiston päivitys käsin:

```bash
npm run gazetteer && npm run collect
```

Koko arkiston uudelleenluku:

```bash
node scripts/update-noise-data.mjs --backfill
```

`main`-haaraan viedyt muutokset testataan, rakennetaan ja julkaistaan automaattisesti
GitHub Pagesiin.

## Tekijä

[Eero Siivola](https://esiivola.github.io/)
