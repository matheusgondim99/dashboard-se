export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { subdomain, token } = req.query;
  if (!subdomain || !token) return res.status(400).json({ error: 'Missing params' });

  const kfetch = async (path, params = {}) => {
    const qs = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
    const url = `https://${subdomain}.kommo.com/api/v4/${path}${qs ? '?' + qs : ''}`;
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + path);
    return r.json();
  };

  const kfetchContacts = async (ids) => {
    const qs = ids.map(id => `filter[id][]=${id}`).join('&');
    const url = `https://${subdomain}.kommo.com/api/v4/contacts?${qs}&with=custom_fields`;
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on contacts');
    return r.json();
  };

  const CLOSER_PIPELINE_ID = 11997467;

  try {
    // Busca stages, leads F-SE e leads do Closer pipeline em paralelo
    const [pipelinesResult, ...allPagesResults] = await Promise.allSettled([
      kfetch('leads/pipelines'),
      kfetch('leads', { limit: 250, page: 1, with: 'contacts,tags' }),
      kfetch('leads', { limit: 250, page: 2, with: 'contacts,tags' }),
      kfetch('leads', { limit: 250, page: 3, with: 'contacts,tags' }),
      kfetch('leads', { limit: 250, page: 4, with: 'contacts,tags' }),
      kfetch('leads', { limit: 250, page: 5, with: 'contacts,tags' }),
      kfetch('leads', { limit: 250, page: 6, with: 'contacts,tags' }),
      kfetch('leads', { limit: 250, page: 7, with: 'contacts,tags' }),
      // Closer pipeline — inclui leads sem tag F-SE que já foram agendados
      kfetch('leads', { limit: 250, page: 1, with: 'contacts,tags', 'filter[pipeline_id][]': CLOSER_PIPELINE_ID }),
      kfetch('leads', { limit: 250, page: 2, with: 'contacts,tags', 'filter[pipeline_id][]': CLOSER_PIPELINE_ID }),
    ]);

    // Monta mapa de stages
    const stagesMap = {};
    if (pipelinesResult.status === 'fulfilled') {
      (pipelinesResult.value?._embedded?.pipelines || []).forEach(p =>
        (p._embedded?.statuses || []).forEach(s => { stagesMap[s.id] = s.name; })
      );
    }

    // Páginas gerais (F-SE tag filter) vs páginas do Closer pipeline
    const pagesResults = allPagesResults.slice(0, 7);
    const closerPagesResults = allPagesResults.slice(7);

    // Coleta leads F-SE de todas as páginas que retornaram OK
    let all = [];
    const seenIds = new Set();
    for (const result of pagesResults) {
      if (result.status !== 'fulfilled') continue;
      const items = result.value?._embedded?.leads || [];
      if (!items.length) break;
      items.filter(l =>
        (l._embedded?.tags || []).some(t => (t.name || '').toLowerCase().includes('f - se'))
      ).forEach(l => { if (!seenIds.has(l.id)) { seenIds.add(l.id); all.push(l); } });
    }

    // Adiciona leads do Closer pipeline (sem filtro de tag — já foram agendados)
    for (const result of closerPagesResults) {
      if (result.status !== 'fulfilled') continue;
      const items = result.value?._embedded?.leads || [];
      items.forEach(l => { if (!seenIds.has(l.id)) { seenIds.add(l.id); all.push(l); } });
    }

    // Busca contatos em paralelo (batches de 50)
    const cids = [...new Set(all.flatMap(l => (l._embedded?.contacts || []).map(c => c.id)).filter(Boolean))];
    const contactBatches = [];
    for (let i = 0; i < cids.length; i += 50) {
      contactBatches.push(kfetchContacts(cids.slice(i, i + 50)));
    }
    const contactResults = await Promise.allSettled(contactBatches);
    const contacts = {};
    contactResults.forEach(r => {
      if (r.status === 'fulfilled') {
        (r.value?._embedded?.contacts || []).forEach(c => { contacts[c.id] = c; });
      }
    });

    return res.status(200).json({ leads: all, contacts, stagesMap });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
