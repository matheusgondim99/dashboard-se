export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
 
  const token     = process.env.KOMMO_TOKEN;
  const subdomain = process.env.KOMMO_SUBDOMAIN;
 
  if (!token || !subdomain) {
    return res.status(404).json({ error: 'Kommo env vars not configured' });
  }
 
  return res.status(200).json({ token, subdomain });
}
 
