# mustafa-website

Jouw project voor de AI-training. Wat de agent hier bouwt, wordt live gezet op
**https://mustafa.sdai.nl**.

## Hoe het werkt
- Alles in deze map draait in jouw container onder `/workspace/mustafa-website`.
- Er draait automatisch een dev-server op **poort 3000** (zie `server.js`), die
  nginx doorzet naar `https://mustafa.sdai.nl`.
- De **browser-IDE** staat op `https://ide-mustafa.sdai.nl`.

## Starten / stoppen van de server
De container start de server automatisch. Wil je hem zelf draaien:

```bash
npm run dev          # = node server.js  (poort 3000)
```

Gebruik je een eigen framework (Vite, Next, Express, …)? Zorg dat het op
`0.0.0.0:3000` luistert, en zet zo nodig de auto-server uit met
`sudo supervisorctl stop appserver`.

## Je werk opslaan (git push)
De container heeft schrijfrechten op deze repo via een deploy-key:

```bash
git add -A
git commit -m "beschrijf je wijziging"
git push
```

Repo: `git@github.com:sayfjawad/mustafa-website.git`
