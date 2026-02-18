const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const KV_KEY = 'tracker_recruiters';
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Create Redis client using environment variables set by Vercel integration
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Validate HMAC token (same logic as auth.js)
function validateToken(token, secret) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const timestamp = parts[0];
  const signature = parts[1];

  const expected = crypto.createHmac('sha256', secret).update(timestamp).digest('hex');
  if (signature !== expected) return false;

  const age = Date.now() - parseInt(timestamp, 10);
  if (age > TOKEN_MAX_AGE_MS) return false;

  return true;
}

module.exports = async function handler(req, res) {
  // Allow requests from any origin (single-user app)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Require auth for all requests
  const secret = process.env.AUTH_SECRET;
  if (secret) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!validateToken(token, secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    if (req.method === 'GET') {
      const data = await redis.get(KV_KEY);
      // Return in {recruiters: [...]} wrapper format
      const recruiters = Array.isArray(data) ? data : (data && data.recruiters ? data.recruiters : []);
      return res.status(200).json({ recruiters: recruiters, lastModified: new Date().toISOString() });
    }

    if (req.method === 'POST') {
      const body = req.body;

      // Accept both {recruiters: [...]} wrapper and plain array
      const recruiters = Array.isArray(body) ? body : (body && Array.isArray(body.recruiters) ? body.recruiters : null);

      if (!recruiters) {
        return res.status(400).json({ error: 'recruiters must be an array' });
      }

      await redis.set(KV_KEY, recruiters);
      return res.status(200).json({ success: true, lastModified: new Date().toISOString() });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Recruiters API error:', error);

    // If Redis is not configured yet, return empty data gracefully
    if (req.method === 'GET') {
      return res.status(200).json({ recruiters: [], lastModified: null });
    }
    return res.status(503).json({ error: 'Database not connected yet.' });
  }
};
