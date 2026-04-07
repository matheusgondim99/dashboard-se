export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { subdomain, token, path, ...rest } = req.query;
  if (!subdomain || !token || !path) return res.status(400).json({ error: 'Missing params' });

  const params = new URLSearchParams(rest).toString();
  const url = `https://${subdomain}.kommo.com/api/v4/${path}${params ? '?' + params : ''}`;

  try {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
