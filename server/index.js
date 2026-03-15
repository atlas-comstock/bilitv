const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const bilibili = require('./bilibili');

const METADATA_STALE_MS = parseInt(process.env.METADATA_STALE_MS || String(1000 * 60 * 60 * 6), 10); // 6 hours
const WORKER_CHECK_INTERVAL_MS = parseInt(process.env.WORKER_CHECK_INTERVAL_MS || String(60 * 1000), 10); // 1 minute
const WORKER_MAX_CONCURRENT = parseInt(process.env.WORKER_MAX_CONCURRENT || '3', 10);
const WORKER_BATCH_LIMIT = parseInt(process.env.WORKER_BATCH_LIMIT || '20', 10);


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

// Fetch metadata from Bilibili and persist into channels.json
async function fetchAndSaveMetadata(bvid) {
  if (!bvid) throw new Error('missing bvid');
  try {
    const meta = await bilibili.fetchMetadata(bvid);
    // attach to channels.json
    const channels = await loadChannels();
    let updated = false;
    for (const ch of channels) {
      if (!ch.items) continue;
      for (const item of ch.items) {
        if (item.bvid === bvid) {
          item.title = meta.title || item.title || '';
          item.pic = meta.pic || item.pic || '';
          item.owner = meta.owner || item.owner || '';
          item.stat = meta.stat || item.stat || {};
          item.lastFetchedAt = Date.now();
          updated = true;
        }
      }
    }
    if (updated) {
      await saveChannels(channels);
      // broadcast to SSE clients
      sendSseEvent({ type: 'metadata', payload: { bvid, meta: Object.assign({}, meta, { lastFetchedAt: Date.now() }) } });
    }
    return meta;
  } catch (err) {
    console.warn('fetchAndSaveMetadata error for', bvid, err && err.message);
    throw err;
  }
}

let workerRunning = false;
async function metadataWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const channels = await loadChannels();
    const now = Date.now();
    const toFetch = [];
    for (const ch of channels) {
      if (!ch.items) continue;
      for (const item of ch.items) {
        const last = item.lastFetchedAt || 0;
        if (!last || (now - last) > METADATA_STALE_MS) {
          toFetch.push(item.bvid);
        }
      }
    }
    if (toFetch.length === 0) return;
    // limit batch size to avoid bursts
    const tasks = toFetch.slice(0, WORKER_BATCH_LIMIT);
    let idx = 0;
    const concurrency = WORKER_MAX_CONCURRENT;
    const runners = new Array(concurrency).fill(null).map(async () => {
      while (true) {
        let bvid;
        if (idx >= tasks.length) break;
        bvid = tasks[idx++];
        try {
          await fetchAndSaveMetadata(bvid);
        } catch (e) {
          // ignore individual failures
        }
      }
    });
    await Promise.all(runners);
  } catch (e) {
    console.warn('metadataWorker error', e && e.message);
  } finally {
    workerRunning = false;
  }
}

// start worker only in long-running server mode
if (!process.env.VERCEL) {
  setInterval(metadataWorker, WORKER_CHECK_INTERVAL_MS);
  // run one pass on startup (non-blocking)
  metadataWorker().catch(()=>{});
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
    // fetch, persist and return
    const meta = await fetchAndSaveMetadata(bvid);
    res.json(meta);
  } catch (e) {
    // if fetch failed, attempt to return any cached entry from channels.json
    try {
      const channels = await loadChannels();
      for (const ch of channels) {
        if (!ch.items) continue;
        for (const item of ch.items) {
          if (item.bvid === bvid) {
            return res.json({
              bvid,
              title: item.title || '',
              owner: item.owner || '',
              pic: item.pic || '',
              stat: item.stat || {},
              lastFetchedAt: item.lastFetchedAt || null
            });
          }
        }
      }
    } catch (e2) {}
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
  // asynchronously fetch metadata for these bvids (non-blocking)
  (async () => {
    for (const bv of bvids) {
      try { await fetchAndSaveMetadata(bv); } catch (e) { /* ignore */ }
    }
  })();
  res.json({ ok: true, channel });
});

module.exports = app;

if (require.main === module) {
  const HOST = process.env.HOST || '::';
  app.listen(PORT, HOST, () => {
    const hostLabel = (HOST === '::') ? 'localhost' : HOST;
    console.log(`BiliTV server running at http://${hostLabel}:${PORT} (host=${HOST})`);
  });
}
