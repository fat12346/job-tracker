const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const FEED_KEY = 'tracker_feed';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Search term used for all job board queries
const SEARCH_KEYWORDS = 'Business Architect';

// --- Reed API ---
async function fetchReed() {
  const apiKey = (process.env.REED_API_KEY || '').trim();
  if (!apiKey) {
    console.log('REED_API_KEY not set, skipping Reed');
    return [];
  }

  // Basic auth: API key as username, empty password
  const auth = Buffer.from(apiKey + ':').toString('base64');

  const params = new URLSearchParams({
    keywords: SEARCH_KEYWORDS,
    resultsToTake: '50',
    contract: 'true',
  });

  const url = 'https://www.reed.co.uk/api/1.0/search?' + params.toString();
  const res = await fetch(url, {
    headers: { 'Authorization': 'Basic ' + auth },
  });

  if (!res.ok) {
    console.error('Reed API error:', res.status, await res.text());
    return [];
  }

  const data = await res.json();
  const results = data.results || data || [];

  return results.map(function (job) {
    return {
      id: 'reed-' + job.jobId,
      title: job.jobTitle || '',
      company: job.employerName || '',
      location: job.locationName || '',
      salaryText: formatSalary(job.minimumSalary, job.maximumSalary),
      jobType: 'contract',
      datePosted: job.date || '',
      description: (job.jobDescription || '').substring(0, 200),
      jobLink: 'https://www.reed.co.uk/jobs/' + job.jobId,
      source: 'reed',
    };
  });
}

// --- Adzuna API ---
async function fetchAdzuna() {
  // Trim whitespace/newlines that may be stuck on the env var values
  const appId = (process.env.ADZUNA_APP_ID || '').trim();
  const appKey = (process.env.ADZUNA_APP_KEY || '').trim();
  if (!appId || !appKey) {
    console.log('Adzuna credentials not set, skipping Adzuna');
    return [];
  }

  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what: SEARCH_KEYWORDS,
    results_per_page: '50',
    'content-type': 'application/json',
  });

  const url = 'https://api.adzuna.com/v1/api/jobs/gb/search/1?' + params.toString();
  const res = await fetch(url);

  if (!res.ok) {
    console.error('Adzuna API error:', res.status, await res.text());
    return [];
  }

  const data = await res.json();
  const results = data.results || [];

  return results.map(function (job) {
    return {
      id: 'adzuna-' + job.id,
      title: job.title || '',
      company: (job.company && job.company.display_name) || '',
      location: (job.location && job.location.display_name) || '',
      salaryText: formatSalary(job.salary_min, job.salary_max),
      jobType: job.contract_type === 'permanent' ? 'permanent' : 'contract',
      datePosted: job.created || '',
      description: (job.description || '').substring(0, 200),
      jobLink: job.redirect_url || '',
      source: 'adzuna',
    };
  });
}

// Build a readable salary string from min/max values
function formatSalary(min, max) {
  if (!min && !max) return '';
  if (min && max && min !== max) return '\u00A3' + Math.round(min).toLocaleString() + ' - \u00A3' + Math.round(max).toLocaleString();
  if (min) return '\u00A3' + Math.round(min).toLocaleString();
  if (max) return '\u00A3' + Math.round(max).toLocaleString();
  return '';
}

module.exports = async function handler(req, res) {
  // Only allow POST (triggered by Vercel cron or manual refresh)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify the request is from Vercel cron or an authorised caller
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';

  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Starting job feed scan...');

  try {
    // Fetch from all sources at the same time
    const [reedJobs, adzunaJobs] = await Promise.all([
      fetchReed(),
      fetchAdzuna(),
    ]);

    const allItems = [].concat(reedJobs, adzunaJobs);

    console.log('Found', reedJobs.length, 'Reed jobs,', adzunaJobs.length, 'Adzuna jobs');

    // Remove duplicates by id
    const seen = {};
    const unique = allItems.filter(function (item) {
      if (seen[item.id]) return false;
      seen[item.id] = true;
      return true;
    });

    // Store as the feed with scan metadata
    const feedData = {
      items: unique,
      meta: {
        lastScan: new Date().toISOString(),
        reedCount: reedJobs.length,
        adzunaCount: adzunaJobs.length,
      },
    };

    await redis.set(FEED_KEY, feedData);

    console.log('Feed scan complete. Total unique items:', unique.length);

    return res.status(200).json({
      success: true,
      totalItems: unique.length,
      reed: reedJobs.length,
      adzuna: adzunaJobs.length,
    });
  } catch (error) {
    console.error('Scan error:', error);
    return res.status(500).json({ error: 'Scan failed: ' + error.message });
  }
};
