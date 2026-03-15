const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));

// Simple SSE implementation for remote control
let sseClients = [];
function sendSseEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\\n\\n`;
  sseClients.forEach(res => res.write(payload));
}

app.get('/sse', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders && res.flushHeaders();
  // keep-alive
  res.write(':ok\\n\\n');
  sseClients.push(res);
  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// control endpoint to broadcast events to connected clients
app.post('/api/control', (req, res) => {
  const body = req.body;
  if (!body) return res.status(400).json({ error: 'missing body' });
  sendSseEvent({ type: 'control', payload: body });
  res.json({ ok: true });
});

const DATA_PATH = path.join(__dirname, '..', 'data', 'channels.json');

async function loadChannels() {
  try {
    const txt = await fsp.readFile(DATA_PATH, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    return [];
  }
}

async function saveChannels(channels) {
  await fsp.writeFile(DATA_PATH, JSON.stringify(channels, null, 2), 'utf8');
}

app.get('/api/channels', async (req, res) => {
  const channels = await loadChannels();
  res.json(channels);
});

app.get('/api/channel/:id', async (req, res) => {
  const channels = await loadChannels();
  const channel = channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  res.json(channel);
});

app.get('/api/metadata/:bvid', async (req, res) => {
  const bvid = req.params.bvid;
  if (!bvid) return res.status(400).json({ error: 'missing bvid' });
  try {
    const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
    const r = await fetch(apiUrl, { headers: { 'User-Agent': 'BiliTV/1.0' } });
    const json = await r.json();
    if (json && json.code === 0 && json.data) {
      const d = json.data;
      const meta = {
        bvid: bvid,
        title: d.title,
        owner: d.owner ? d.owner.name : (d.uploader || ''),
        pic: d.pic,
        stat: d.stat || {}
      };
      return res.json(meta);
    } else {
      return res.status(502).json({ error: 'bad upstream', details: json });
    }
  } catch (e) {
    return res.status(500).json({ error: 'fetch failed', message: e.message });
  }
});

app.post('/api/import', async (req, res) => {
  // Accept JSON { name, items: [ ... ] } or raw text body with lines
  let name = req.body && req.body.name;
  let items = req.body && req.body.items;

  if (!name && !items) {
    if (typeof req.body === 'string') {
      const lines = req.body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      items = lines;
      name = 'Imported ' + Date.now();
    } else {
      items = (req.body && req.body.items) || [];
      name = (req.body && req.body.name) || ('Imported ' + Date.now());
    }
  }

  function extractBvid(s) {
    if (!s) return null;
    s = s.trim();
    const m1 = s.match(/(BV[0-9A-Za-z]+)/);
    if (m1) return m1[1];
    const m2 = s.match(/(bv[0-9a-zA-Z]+)/i);
    if (m2) return m2[1];
    return null;
  }

  const bvids = (Array.isArray(items) ? items : [items]).map(extractBvid).filter(Boolean);
  if (bvids.length === 0) return res.status(400).json({ error: 'no bvids found' });

  const channels = await loadChannels();
  const id = Date.now().toString();
  const channel = { id: id, name: name, items: bvids.map(bv => ({ bvid: bv, title: '' })) };
  channels.push(channel);
  await saveChannels(channels);
  res.json({ ok: true, channel });
});

app.listen(PORT, () => {
  console.log(`BiliTV server running at http://localhost:${PORT}`);
});
