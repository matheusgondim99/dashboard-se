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

  const kfetchRaw = async (url) => {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!r.ok) return null;
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
  const SDR_PIPELINE_ID = 13105099;

  try {
    // Busca stages, leads F-SE e leads do Closer pipeline em paralelo
    const [pipelinesResult, ...allPagesResults] = await Promise.allSettled([
      kfetch('leads/pipelines'),
      kfetch('leads', { limit: 250, page: 1, with: 'contacts,tags,custom_fields' }),
      kfetch('leads', { limit: 250, page: 2, with: 'contacts,tags,custom_fields' }),
      kfetch('leads', { limit: 250, page: 3, with: 'contacts,tags,custom_fields' }),
      kfetch('leads', { limit: 250, page: 4, with: 'contacts,tags,custom_fields' }),
      kfetch('leads', { limit: 250, page: 5, with: 'contacts,tags,custom_fields' }),
      kfetch('leads', { limit: 250, page: 6, with: 'contacts,tags,custom_fields' }),
      kfetch('leads', { limit: 250, page: 7, with: 'contacts,tags,custom_fields' }),
      // Closer pipeline — inclui leads sem tag F-SE que já foram agendados
      kfetch('leads', { limit: 250, page: 1, with: 'contacts,tags,custom_fields', 'filter[pipeline_id][]': CLOSER_PIPELINE_ID }),
      kfetch('leads', { limit: 250, page: 2, with: 'contacts,tags,custom_fields', 'filter[pipeline_id][]': CLOSER_PIPELINE_ID }),
    ]);

    // Monta mapa de stages, detecta pipeline de Recuperação e coleta stages do SDR
    const stagesMap = {};
    const sdrStatusIds = new Set(); // status_ids que pertencem ao pipeline SDR
    let RECUPERACAO_PIPELINE_ID = null;
    if (pipelinesResult.status === 'fulfilled') {
      (pipelinesResult.value?._embedded?.pipelines || []).forEach(p => {
        if ((p.name || '').toLowerCase().includes('recup')) RECUPERACAO_PIPELINE_ID = p.id;
        (p._embedded?.statuses || []).forEach(s => {
          stagesMap[s.id] = s.name;
          if (p.id === SDR_PIPELINE_ID) sdrStatusIds.add(s.id);
        });
      });
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
      items.filter(l => {
        const tags = l._embedded?.tags || [];
        return tags.some(t => {
          const tn = (t.name || '').toLowerCase();
          return tn.includes('f - se') || tn.includes('f - leads go');
        });
      }).forEach(l => { if (!seenIds.has(l.id)) { seenIds.add(l.id); all.push(l); } });
    }

    // Adiciona leads do Closer pipeline (sem filtro de tag — já foram agendados)
    for (const result of closerPagesResults) {
      if (result.status !== 'fulfilled') continue;
      const items = result.value?._embedded?.leads || [];
      items.forEach(l => { if (!seenIds.has(l.id)) { seenIds.add(l.id); all.push(l); } });
    }

    // Busca leads do pipeline de Recuperação (leads perdidos em reengajamento)
    // Necessário porque esses leads saem das páginas gerais ao serem movidos
    if (RECUPERACAO_PIPELINE_ID) {
      const recuperResults = await Promise.allSettled([
        kfetch('leads', { limit: 250, page: 1, with: 'contacts,tags,custom_fields', 'filter[pipeline_id][]': RECUPERACAO_PIPELINE_ID }),
        kfetch('leads', { limit: 250, page: 2, with: 'contacts,tags,custom_fields', 'filter[pipeline_id][]': RECUPERACAO_PIPELINE_ID }),
      ]);
      for (const result of recuperResults) {
        if (result.status !== 'fulfilled') continue;
        const items = result.value?._embedded?.leads || [];
        items.forEach(l => { if (!seenIds.has(l.id)) { seenIds.add(l.id); all.push(l); } });
      }
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

    // Busca histórico de mudanças de stage para cada lead (events API)
    // Batches de 50 IDs — retorna quando cada lead entrou em cada stage
    const allIds = all.map(l => l.id);
    const eventMap = {}; // leadId → [{status_id, ts}]
    const eventBatches = [];
    for (let i = 0; i < allIds.length; i += 50) {
      const batch = allIds.slice(i, i + 50);
      const qs = batch.map(id => `filter[entity_id][]=${id}`).join('&')
        + '&filter[type][]=lead_status_changed&limit=250';
      const url = `https://${subdomain}.kommo.com/api/v4/events?${qs}`;
      eventBatches.push(kfetchRaw(url));
    }
    const sdrEntryMap = {}; // leadId → timestamp da primeira vez que entrou em qualquer stage SDR
    const eventResults = await Promise.allSettled(eventBatches);
    eventResults.forEach(r => {
      if (r.status !== 'fulfilled' || !r.value) return;
      (r.value._embedded?.events || []).forEach(ev => {
        const leadId = ev.entity_id;
        const statusId = ev.value_after?.[0]?.lead_status?.id;
        if (!leadId || !statusId) return;
        if (!eventMap[leadId]) eventMap[leadId] = [];
        eventMap[leadId].push({ status_id: statusId, ts: ev.created_at });
        // Detecta primeira entrada em stage do pipeline SDR
        if (sdrStatusIds.has(statusId)) {
          if (!sdrEntryMap[leadId] || ev.created_at < sdrEntryMap[leadId]) {
            sdrEntryMap[leadId] = ev.created_at;
          }
        }
      });
    });
    // Ordena cada lista por timestamp crescente
    Object.values(eventMap).forEach(arr => arr.sort((a, b) => a.ts - b.ts));

    // Busca eventos lead_changed para detectar quando o campo Abordagem foi preenchido
    // Lote separado para não consumir a cota de 250 dos eventos de stage
    const abordagemMap = {}; // leadId → timestamp da primeira vez que abordagem foi preenchida
    const abEventBatches = [];
    for (let i = 0; i < allIds.length; i += 50) {
      const batch = allIds.slice(i, i + 50);
      const qs = batch.map(id => `filter[entity_id][]=${id}`).join('&')
        + '&filter[type][]=lead_changed&limit=250';
      const url = `https://${subdomain}.kommo.com/api/v4/events?${qs}`;
      abEventBatches.push(kfetchRaw(url));
    }
    const abEventResults = await Promise.allSettled(abEventBatches);
    abEventResults.forEach(r => {
      if (r.status !== 'fulfilled' || !r.value) return;
      (r.value._embedded?.events || []).forEach(ev => {
        const leadId = ev.entity_id;
        if (!leadId) return;
        for (const change of (ev.value_after || [])) {
          // Kommo usa 'custom_field' ou 'custom_field_value' dependendo da versão
          const field = change.custom_field || change.custom_field_value;
          if (!field) continue;
          const fname = (field.field_name || '').toLowerCase();
          if (!fname.includes('abordagem')) continue;
          const newVal = field.values?.[0]?.value;
          if (!newVal || !String(newVal).trim()) continue;
          // Guarda somente o PRIMEIRO preenchimento
          if (!abordagemMap[leadId] || ev.created_at < abordagemMap[leadId]) {
            abordagemMap[leadId] = ev.created_at;
          }
        }
      });
    });

    return res.status(200).json({ leads: all, contacts, stagesMap, events: eventMap, abordagemMap, sdrEntryMap });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
