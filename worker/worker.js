/**
 * Ascend AI — Instagram Audit Worker
 * Cloudflare Worker that powers the live audit tool on ascendagency.xyz
 *
 * Flow: Accept IG handle + niche → attempt IG data scrape → call OpenRouter (Claude Sonnet) → return structured audit
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PRIMARY_MODEL = 'anthropic/claude-sonnet-4-6';
const FALLBACK_MODEL = 'deepseek/deepseek-chat-v3-0324';

// In-memory rate limiting (resets on cold start — good enough for abuse prevention)
const rateLimitMap = new Map();
const RATE_LIMIT = 10; // max audits per IP per hour
const RATE_WINDOW = 3600000; // 1 hour in ms

// Simple in-memory cache (fallback when KV not bound)
const memCache = new Map();
const CACHE_TTL = 86400000; // 24 hours

function corsHeaders(origin, allowedOrigin) {
  // Allow localhost for dev + production domain
  const allowed = origin === allowedOrigin
    || origin === 'https://ascendagency.xyz'
    || origin === 'http://localhost:8080'
    || origin === 'http://127.0.0.1:8080'
    || origin?.startsWith('http://localhost:')
    || origin?.startsWith('http://127.0.0.1:');

  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://ascendagency.xyz',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

async function getCached(key, env) {
  // Try KV first
  if (env.AUDIT_CACHE) {
    try {
      const val = await env.AUDIT_CACHE.get(key);
      if (val) return JSON.parse(val);
    } catch (_) {}
  }
  // Fallback to memory cache
  const entry = memCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

async function setCache(key, data, env) {
  // Try KV first
  if (env.AUDIT_CACHE) {
    try {
      await env.AUDIT_CACHE.put(key, JSON.stringify(data), { expirationTtl: 86400 });
    } catch (_) {}
  }
  // Always set memory cache too
  memCache.set(key, { data, ts: Date.now() });
}

async function scrapeInstagramData(handle) {
  const cleanHandle = handle.replace(/^@/, '').trim().toLowerCase();
  if (!cleanHandle) return null;

  try {
    // Try fetching the IG profile page and extracting meta tags
    const resp = await fetch(`https://www.instagram.com/${cleanHandle}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!resp.ok) return null;

    const html = await resp.text();

    // Extract from meta tags
    const ogDesc = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]*?)"/i);
    const ogTitle = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]*?)"/i);
    const ogImage = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]*?)"/i);

    // Try to extract follower/following/post counts from og:description
    // Format: "X Followers, Y Following, Z Posts - ..."
    let followers = null, following = null, posts = null, bio = null;
    if (ogDesc?.[1]) {
      const desc = ogDesc[1];
      const followersMatch = desc.match(/([\d,.]+[KkMm]?)\s*Followers/i);
      const followingMatch = desc.match(/([\d,.]+[KkMm]?)\s*Following/i);
      const postsMatch = desc.match(/([\d,.]+[KkMm]?)\s*Posts/i);
      if (followersMatch) followers = followersMatch[1];
      if (followingMatch) following = followingMatch[1];
      if (postsMatch) posts = postsMatch[1];
      // Bio is usually after the counts
      const bioMatch = desc.match(/Posts\s*[-–—]\s*(.*)/i);
      if (bioMatch) bio = bioMatch[1].trim().replace(/"/g, '');
    }

    const name = ogTitle?.[1]?.replace(/\s*\(@\w+\).*/, '').trim() || cleanHandle;
    const profilePic = ogImage?.[1] || null;

    if (followers || posts || bio) {
      return { handle: cleanHandle, name, followers, following, posts, bio, profilePic, scraped: true };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function buildSystemPrompt(igData, niche) {
  const nicheLabels = {
    medspa: 'Med Spa / Aesthetics',
    dental: 'Cosmetic Dentistry',
    chiro: 'Chiropractic / Wellness',
    realestate: 'Real Estate',
    law: 'Law Firm',
    restaurant: 'Restaurant / Food Service',
    ecommerce: 'E-commerce',
    other: 'Local Business',
  };
  const nicheLabel = nicheLabels[niche] || nicheLabels.other;

  let igContext = '';
  if (igData?.scraped) {
    igContext = `
REAL DATA FOUND for @${igData.handle}:
- Display name: ${igData.name}
- Followers: ${igData.followers || 'unknown'}
- Following: ${igData.following || 'unknown'}
- Posts: ${igData.posts || 'unknown'}
- Bio: ${igData.bio || 'none found'}

Use this real data in your analysis. Reference specific numbers.`;
  } else {
    igContext = `
No public data could be scraped for @${igData?.handle || 'unknown'}.
Provide a general audit based on common patterns in the ${nicheLabel} industry.
Frame recommendations around what you'd typically find for businesses in this niche that aren't maximizing their Instagram.`;
  }

  return `You are a senior Instagram growth strategist at Ascend AI. You produce concise, high-value Instagram audits.

INDUSTRY: ${nicheLabel}
${igContext}

Return a JSON object (no markdown, no code fences, just raw JSON) with this exact structure:
{
  "score": <number 1-100, overall Instagram health score>,
  "scoreLabel": "<one of: Critical, Poor, Below Average, Average, Good, Strong, Excellent>",
  "handle": "@<their handle>",
  "businessName": "<their business name or handle>",
  "niche": "${nicheLabel}",
  "sections": {
    "postingFrequency": {
      "grade": "<A/B/C/D/F>",
      "current": "<e.g. '2x per week' or 'estimated based on industry'>",
      "recommended": "<e.g. '5-7x per week'>",
      "insight": "<1 sentence>"
    },
    "contentQuality": {
      "grade": "<A/B/C/D/F>",
      "insight": "<1-2 sentences about content mix, format variety, visual consistency>"
    },
    "competitorGap": {
      "topCompetitor": "<name a real or plausible competitor in their niche/market>",
      "competitorAdvantage": "<what the competitor does better, 1 sentence>",
      "gap": "<how far behind, 1 sentence>"
    },
    "audienceEngagement": {
      "grade": "<A/B/C/D/F>",
      "insight": "<1 sentence about engagement rate, comments, saves>"
    }
  },
  "actionItems": [
    "<specific, actionable recommendation 1>",
    "<specific, actionable recommendation 2>",
    "<specific, actionable recommendation 3>",
    "<specific, actionable recommendation 4>",
    "<specific, actionable recommendation 5>"
  ],
  "revenueOpportunity": {
    "monthlyEstimate": "<e.g. '$3,000 - $8,000'>",
    "basis": "<1 sentence explaining the estimate>"
  }
}

RULES:
- Be specific and data-driven, not generic
- Reference real industry benchmarks
- If you have real follower/post data, use it to calculate engagement estimates
- Action items must be immediately actionable (not "post more" but "post 5 Reels per week featuring before/after transformations")
- Revenue opportunity should be realistic for the niche and audience size
- Keep all text concise — this renders in a dashboard card`;
}

async function callOpenRouter(systemPrompt, handle, apiKey) {
  const body = {
    model: PRIMARY_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Generate the Instagram audit for @${handle}.` },
    ],
    max_tokens: 2000,
    temperature: 0.3,
  };

  let resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://ascendagency.xyz',
      'X-Title': 'Ascend AI Audit Tool',
    },
    body: JSON.stringify(body),
  });

  // If primary model fails, try fallback
  if (!resp.ok) {
    body.model = FALLBACK_MODEL;
    resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ascendagency.xyz',
        'X-Title': 'Ascend AI Audit Tool',
      },
      body: JSON.stringify(body),
    });
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenRouter API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenRouter');

  // Parse JSON — extract the JSON object robustly
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    // Only accept POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    // Rate limiting
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIP)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again in an hour.' }), {
        status: 429,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    try {
      const { handle, niche = 'other' } = await request.json();

      if (!handle || typeof handle !== 'string') {
        return new Response(JSON.stringify({ error: 'Missing or invalid "handle" field' }), {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      const cleanHandle = handle.replace(/^@/, '').trim().toLowerCase();
      const cacheKey = `audit:${cleanHandle}:${niche}`;

      // Check cache
      const cached = await getCached(cacheKey, env);
      if (cached) {
        return new Response(JSON.stringify({ ...cached, cached: true }), {
          status: 200,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Attempt Instagram scrape
      const igData = await scrapeInstagramData(cleanHandle) || { handle: cleanHandle, scraped: false };

      // Build prompt and call OpenRouter
      const systemPrompt = buildSystemPrompt(igData, niche);
      const audit = await callOpenRouter(systemPrompt, cleanHandle, env.OPENROUTER_API_KEY);

      // Merge scraped data into result
      const result = {
        ...audit,
        igData: igData.scraped ? {
          followers: igData.followers,
          following: igData.following,
          posts: igData.posts,
          bio: igData.bio,
          profilePic: igData.profilePic,
        } : null,
        generatedAt: new Date().toISOString(),
        cached: false,
      };

      // Cache the result
      await setCache(cacheKey, result, env);

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || 'Internal error' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
  },
};
