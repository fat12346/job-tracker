const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const FEED_KEY = 'tracker_feed';
const DISMISSED_KEY = 'tracker_feed_dismissed';
const JOBS_KEY = 'tracker_jobs';
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
      // Fetch raw feed items and the dismissed list
      const [feedData, dismissedData] = await Promise.all([
        redis.get(FEED_KEY),
        redis.get(DISMISSED_KEY),
      ]);

      const rawItems = Array.isArray(feedData)
        ? feedData
        : (feedData && Array.isArray(feedData.items) ? feedData.items : []);

      const meta = (feedData && feedData.meta) ? feedData.meta : {};
      const dismissed = Array.isArray(dismissedData) ? dismissedData : [];

      // Filter out any items the user has already dismissed
      const items = rawItems.filter(function (item) {
        return dismissed.indexOf(item.id) === -1;
      });

      return res.status(200).json({ items: items, meta: meta });
    }

    if (req.method === 'POST') {
      const { action, feedItemId } = req.body || {};

      if (!action || !feedItemId) {
        return res.status(400).json({ error: 'action and feedItemId are required' });
      }

      if (action === 'dismiss') {
        // Add this item's id to the dismissed list
        const dismissedData = await redis.get(DISMISSED_KEY);
        const dismissed = Array.isArray(dismissedData) ? dismissedData : [];
        if (dismissed.indexOf(feedItemId) === -1) {
          dismissed.push(feedItemId);
        }
        await redis.set(DISMISSED_KEY, dismissed);
        return res.status(200).json({ success: true });
      }

      if (action === 'add-to-tracker') {
        // Find the feed item
        const feedData = await redis.get(FEED_KEY);
        const rawItems = Array.isArray(feedData)
          ? feedData
          : (feedData && Array.isArray(feedData.items) ? feedData.items : []);

        const feedItem = rawItems.find(function (item) {
          return item.id === feedItemId;
        });

        if (!feedItem) {
          return res.status(404).json({ error: 'Feed item not found' });
        }

        // Convert feed item into a tracker job
        const now = new Date().toISOString();
        const newJob = {
          id: 'job-' + Date.now(),
          title: feedItem.title || '',
          company: feedItem.company || '',
          recruiter: '',
          location: feedItem.location || '',
          ir35: '',
          rate: feedItem.salaryText || '',
          duration: '',
          jobType: feedItem.jobType || '',
          starred: false,
          status: 'want',
          dateApplied: '',
          jobLink: feedItem.jobLink || '',
          notes: 'Added from ' + (feedItem.source || 'feed'),
          createdAt: now,
          updatedAt: now,
        };

        // Add the new job to the tracker list
        const jobsData = await redis.get(JOBS_KEY);
        const jobs = Array.isArray(jobsData)
          ? jobsData
          : (jobsData && Array.isArray(jobsData.jobs) ? jobsData.jobs : []);

        jobs.push(newJob);
        await redis.set(JOBS_KEY, jobs);

        // Also dismiss it from the feed so it doesn't show again
        const dismissedData = await redis.get(DISMISSED_KEY);
        const dismissed = Array.isArray(dismissedData) ? dismissedData : [];
        if (dismissed.indexOf(feedItemId) === -1) {
          dismissed.push(feedItemId);
        }
        await redis.set(DISMISSED_KEY, dismissed);

        return res.status(200).json({ success: true, job: newJob });
      }

      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Feed API error:', error);

    // If Redis is not set up yet, return empty feed gracefully
    if (req.method === 'GET') {
      return res.status(200).json({ items: [], meta: {} });
    }
    return res.status(503).json({ error: 'Database not connected yet.' });
  }
};
