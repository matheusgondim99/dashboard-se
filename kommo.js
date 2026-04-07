export default async function handler(req, res) {
  // Allow CORS from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { subdomain, token, path } = req.query;

  if (!subdomain || !token || !path) {
    return res.status(400).json({ error: 'Missing subdomain, token or path' });
  }

  const url = `https://${subdomain}.kommo.com/api/v4/${path}${req.url.includes('?') ? '&' : '?'}${new URLSearchParams(
    Object.fromEntries(Object.entries(req.query).filter(([k]) => !['subdomain','token','path'].includes(k)))
  )}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
