(async function(){
  async function fetchChannels(){ const r = await fetch('/api/channels'); return await r.json(); }
  let channels = await fetchChannels();
  let currentIndex = 0;
  channels.forEach(c => { if (typeof c.playIndex === 'undefined') c.playIndex = 0; });

  const guideEl = document.getElementById('guide');
  const channelsListEl = document.getElementById('channelsList');
  const playerEl = document.getElementById('player');

  const importBtn = document.getElementById('importBtn');
  const importForm = document.getElementById('importForm');
  const importSubmit = document.getElementById('importSubmit');

  importBtn.addEventListener('click', ()=>{ importForm.style.display = importForm.style.display === 'none' ? 'block' : 'none'; });

  importSubmit.addEventListener('click', async ()=>{
    const name = document.getElementById('importName').value.trim() || ('Imported ' + Date.now());
    const raw = document.getElementById('importArea').value.trim();
    if (!raw){ alert('请粘贴 BV 列表或 URL'); return; }
    const lines = raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    const payload = { name: name, items: lines };
    const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await res.json();
    if (res.ok && j.ok){ channels = await fetchChannels(); currentIndex = channels.length - 1; renderGuide(); loadChannel(currentIndex); importForm.style.display='none'; document.getElementById('importArea').value=''; document.getElementById('importName').value=''; }
    else { alert('导入失败: ' + JSON.stringify(j)); }
  });

  function renderGuide(){
    channelsListEl.innerHTML = channels.map((c,i)=>{
      const currentItem = (c.items && c.items[c.playIndex]) ? c.items[c.playIndex].title : '';
      return `<div class="channel ${i===currentIndex?'active':''}" data-idx="${i}"><span class="num">${i+1}</span><span class="name">${c.name}</span><div style="font-size:12px;color:#ccc;margin-top:4px">${currentItem}</div></div>`;
    }).join('');
    document.querySelectorAll('.channel').forEach(el=>{ el.addEventListener('click', ()=>{ currentIndex = Number(el.dataset.idx); loadChannel(currentIndex); }); });
  }

  async function loadChannel(idx){
    const channel = channels[idx];
    if(!channel || !channel.items || channel.items.length===0){ playerEl.innerHTML = '<div style="color:#fff;padding:20px">该频道暂无内容</div>'; renderGuide(); return; }
    const item = channel.items[channel.playIndex || 0];
    const src = `https://player.bilibili.com/player.html?bvid=${item.bvid}&page=1`;
    playerEl.innerHTML = `<div style="position:relative;height:100%"><div class="meta" id="metaBlock"><img id="cover" src="" style="height:48px;width:80px;object-fit:cover;border-radius:4px;margin-right:8px;vertical-align:middle"/><span id="metaText">${channel.name} — ${item.title}</span></div><iframe id="biliplayer" src="${src}" allowfullscreen></iframe></div>`;
    renderGuide();

    // fetch metadata
    fetch('/api/metadata/' + encodeURIComponent(item.bvid)).then(r=>r.json()).then(meta=>{
      if (meta && meta.title){
        const metaText = document.getElementById('metaText');
        metaText.textContent = `${meta.title} — ${meta.owner || ''}`;
        const cover = document.getElementById('cover');
        if (meta.pic) cover.src = meta.pic;
      }
      item.title = (meta && meta.title) ? meta.title : item.title;
      renderGuide();
    }).catch(()=>{});

    // message listener for embedded player
    window.addEventListener('message', function onMsg(e){
      try {
        const d = (typeof e.data === 'string') ? (()=>{ try { return JSON.parse(e.data); } catch(e){ return null; } })() : e.data;
        if (d && (d.event === 'play_end' || d.type === 'ended' || d.action === 'ended')){
          const ch = channels[currentIndex];
          ch.playIndex = ((ch.playIndex || 0) + 1) % (ch.items.length || 1);
          loadChannel(currentIndex);
        }
      } catch(err){}
    }, { once: false });
  }

  // SSE remote control
  try{
    const es = new EventSource('/sse');
    es.onmessage = function(ev){
      try{
        const data = JSON.parse(ev.data);
        if (data && data.type === 'control'){
          const p = data.payload || {};
          if (p.action === 'tune' && typeof p.idx === 'number'){
            currentIndex = ((p.idx % channels.length) + channels.length) % channels.length; loadChannel(currentIndex);
          } else if (p.action === 'next'){
            const ch = channels[currentIndex]; ch.playIndex = ((ch.playIndex || 0) + 1) % (ch.items.length || 1); loadChannel(currentIndex);
          } else if (p.action === 'prev'){
            const ch = channels[currentIndex]; ch.playIndex = ((ch.playIndex || 0) - 1 + (ch.items.length || 1)) % (ch.items.length || 1); loadChannel(currentIndex);
          } else if (p.action === 'up'){
            currentIndex = (currentIndex - 1 + channels.length) % channels.length; loadChannel(currentIndex);
          } else if (p.action === 'down'){
            currentIndex = (currentIndex + 1) % channels.length; loadChannel(currentIndex);
          }
        }
      }catch(e){}
    };
  }catch(e){ console.warn('SSE not supported', e); }

  document.addEventListener('keydown', (e)=>{
    if(e.key === 'ArrowUp'){ currentIndex = (currentIndex - 1 + channels.length) % channels.length; loadChannel(currentIndex); }
    else if(e.key === 'ArrowDown'){ currentIndex = (currentIndex + 1) % channels.length; loadChannel(currentIndex); }
    else if(e.key === 'ArrowRight'){ const ch = channels[currentIndex]; ch.playIndex = ((ch.playIndex || 0) + 1) % (ch.items.length || 1); loadChannel(currentIndex); }
    else if(e.key === 'ArrowLeft'){ const ch = channels[currentIndex]; ch.playIndex = ((ch.playIndex || 0) - 1 + (ch.items.length || 1)) % (ch.items.length || 1); loadChannel(currentIndex); }
    else if(e.key === 'g' || e.key === 'G'){ guideEl.classList.toggle('hidden'); }
    else if(e.key === 'i' || e.key === 'I'){ importForm.style.display = importForm.style.display === 'none' ? 'block' : 'none'; }
  });

  renderGuide();
  loadChannel(0);
})();
