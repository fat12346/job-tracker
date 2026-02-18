const crypto = require('crypto');

// Auth uses HMAC-SHA256 tokens: "timestamp.signature"
// Token valid for 30 days
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function makeToken(secret) {
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
  return timestamp + '.' + signature;
}

function validateToken(token, secret) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const timestamp = parts[0];
  const signature = parts[1];

  // Check signature
  const expected = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
  if (signature !== expected) return false;

  // Check expiry
  const age = Date.now() - parseInt(timestamp, 10);
  if (age > TOKEN_MAX_AGE_MS) return false;

  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const secret = process.env.AUTH_SECRET;
  const sitePassword = process.env.SITE_PASSWORD;

  if (!secret || !sitePassword) {
    return res.status(500).json({ error: 'Auth not configured' });
  }

  // POST: login with password, receive token
  if (req.method === 'POST') {
    const { password } = req.body || {};
    if (password === sitePassword) {
      return res.status(200).json({ token: makeToken(secret) });
    }
    return res.status(401).json({ error: 'Wrong password' });
  }

  // GET: validate an existing token
  if (req.method === 'GET') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (validateToken(token, secret)) {
      return res.status(200).json({ valid: true });
    }
    return res.status(401).json({ valid: false });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
