// proxy.js
const express = require('express');
const fetch = require('node-fetch'); // v2
const path = require('path');

const app = express();

// Proxyendpunkt: /slapi/* -> journeyplanner.integration.sl.se/*
app.use('/slapi', async (req, res) => {
  const targetUrl = 'https://journeyplanner.integration.sl.se' + req.url.replace('/slapi', '');
  try {
    const r = await fetch(targetUrl, { headers: { accept: 'application/json' } });
    const text = await r.text();
    res.status(r.status);
    // Bas-CORS så din webbläsare tillåter svaren
    res.set('access-control-allow-origin', '*');
    res.set('content-type', r.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (e) {
    res.status(502).send('Proxy error: ' + e.message);
  }
});

// Serva din statiska app
app.use(express.static(path.resolve('.')));

const PORT = 5173;
app.listen(PORT, () => console.log('Öppet på http://localhost:'+PORT));
