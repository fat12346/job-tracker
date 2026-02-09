const { kv } = require('@vercel/kv');

const KV_KEY = 'tracker_jobs';

module.exports = async function handler(req, res) {
  // Allow requests from any origin (single-user app)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      const jobs = await kv.get(KV_KEY);
      return res.status(200).json(jobs || []);
    }

    if (req.method === 'POST') {
      const jobs = req.body;

      if (!Array.isArray(jobs)) {
        return res.status(400).json({ error: 'Expected an array of jobs' });
      }

      await kv.set(KV_KEY, jobs);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('API error:', error);

    // If KV is not configured yet, return empty data gracefully
    if (error.message && error.message.includes('REDIS')) {
      if (req.method === 'GET') {
        return res.status(200).json([]);
      }
      return res.status(503).json({ error: 'Database not connected yet. Add Vercel KV in your project settings.' });
    }

    return res.status(500).json({ error: 'Server error' });
  }
};
