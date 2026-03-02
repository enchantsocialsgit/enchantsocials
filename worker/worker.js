/**
 * Ascend AI — Deep Business Research Engine
 * Cloudflare Worker that powers the free business intelligence report on ascendagency.xyz
 *
 * Flow: Accept IG handle/business + niche → Google search (Serper) → AI analysis (DeepSeek) → 10-section report
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PRIMARY_MODEL = 'deepseek/deepseek-chat-v3-0324';
const FALLBACK_MODEL = 'anthropic/claude-sonnet-4-6';
const SERPER_URL = 'https://google.serper.dev/search';

const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 3600000;

const memCache = new Map();
const CACHE_TTL = 86400000;

function corsHeaders(origin, allowedOrigin) {
  const allowed = origin === allowedOrigin
    || origin === 'https://ascendagency.xyz'
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
  if (env.AUDIT_CACHE) {
    try {
      const val = await env.AUDIT_CACHE.get(key);
      if (val) return JSON.parse(val);
    } catch (_) {}
  }
  const entry = memCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

async function setCache(key, data, env) {
  if (env.AUDIT_CACHE) {
    try {
      await env.AUDIT_CACHE.put(key, JSON.stringify(data), { expirationTtl: 86400 });
    } catch (_) {}
  }
  memCache.set(key, { data, ts: Date.now() });
}

// ─── SERPER GOOGLE SEARCH ────────────────────────────────────────
async function searchGoogle(query, apiKey) {
  try {
    const resp = await fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: 10 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data;
  } catch (_) {
    return null;
  }
}

function extractSearchContext(searchResults1, searchResults2) {
  if (!searchResults1 && !searchResults2) return '';

  let context = '\n\nGOOGLE SEARCH DATA (real, from live search):\n';

  if (searchResults1) {
    // Knowledge graph (Google Business info)
    if (searchResults1.knowledgeGraph) {
      const kg = searchResults1.knowledgeGraph;
      context += `\nGoogle Knowledge Panel:\n`;
      if (kg.title) context += `- Business name: ${kg.title}\n`;
      if (kg.type) context += `- Type: ${kg.type}\n`;
      if (kg.rating) context += `- Google rating: ${kg.rating}/5`;
      if (kg.ratingCount) context += ` (${kg.ratingCount} reviews)`;
      context += '\n';
      if (kg.address) context += `- Address: ${kg.address}\n`;
      if (kg.phone) context += `- Phone: ${kg.phone}\n`;
      if (kg.website) context += `- Website: ${kg.website}\n`;
      if (kg.description) context += `- Description: ${kg.description}\n`;
    }

    // Organic results
    if (searchResults1.organic?.length) {
      context += `\nTop Google results for this business:\n`;
      searchResults1.organic.slice(0, 6).forEach((r, i) => {
        context += `${i + 1}. "${r.title}" — ${r.link}\n`;
        if (r.snippet) context += `   ${r.snippet}\n`;
      });
    }

    // People Also Ask
    if (searchResults1.peopleAlsoAsk?.length) {
      context += `\nPeople also ask about this business/niche:\n`;
      searchResults1.peopleAlsoAsk.slice(0, 3).forEach(q => {
        context += `- ${q.question}\n`;
      });
    }
  }

  if (searchResults2) {
    if (searchResults2.organic?.length) {
      context += `\nCompetitor/industry search results:\n`;
      searchResults2.organic.slice(0, 6).forEach((r, i) => {
        context += `${i + 1}. "${r.title}" — ${r.link}\n`;
        if (r.snippet) context += `   ${r.snippet}\n`;
      });
    }
  }

  return context;
}

// ─── BUILD THE MEGA PROMPT ───────────────────────────────────────
function buildSystemPrompt(handle, niche, searchContext) {
  const nicheLabels = {
    medspa: 'Med Spa / Aesthetics',
    dental: 'Cosmetic Dentistry',
    chiro: 'Chiropractic / Wellness',
    realestate: 'Real Estate',
    law: 'Law Firm',
    restaurant: 'Restaurant / Food Service',
    ecommerce: 'E-commerce / Retail',
    gym: 'Gym / Fitness Studio',
    salon: 'Hair Salon / Barbershop',
    auto: 'Auto Dealer / Mechanic',
    contractor: 'Contractor / Home Services',
    agency: 'Marketing Agency',
    coaching: 'Coach / Consultant',
    healthcare: 'Doctor / Healthcare',
    other: 'Local Business',
  };
  const nicheLabel = nicheLabels[niche] || nicheLabels.other;

  return `You are a $500/hour business intelligence consultant. A business owner just entered their Instagram handle on our website. Your job is to produce the most impressive, specific, and valuable free business report they've ever seen. Make them think: "How is this free?"

BUSINESS: @${handle}
INDUSTRY: ${nicheLabel}
${searchContext || '\nNo Google search data available. Use your knowledge of this industry and typical businesses in this niche to produce the report. Be specific — name real competitor brands, cite real industry benchmarks, reference real trends.'}

Return ONLY a JSON object (no markdown, no code fences, no explanation — just the raw JSON) with this EXACT structure:

{
  "businessName": "<their business name — infer from handle, or use handle if unknown>",
  "handle": "@${handle}",
  "niche": "${nicheLabel}",
  "overallScore": <number 1-100>,
  "scoreLabel": "<Critical|Poor|Below Average|Average|Good|Strong|Excellent>",
  "sections": {
    "1_onlinePresence": {
      "title": "Online Presence",
      "score": <1-10>,
      "maxScore": 10,
      "findings": [
        "<finding about their website>",
        "<finding about Google Business / reviews>",
        "<finding about their Instagram>",
        "<finding about TikTok/YouTube/other platforms>",
        "<finding about overall digital footprint>"
      ],
      "verdict": "<1-2 punchy sentences — brutally honest but constructive>"
    },
    "2_instagramHealth": {
      "title": "Instagram Deep Dive",
      "score": <1-10>,
      "maxScore": 10,
      "followers": "<estimated or known>",
      "posts": "<estimated or known>",
      "frequency": "<e.g. '~2 posts/month'>",
      "estimatedEngagement": "<e.g. '1.2%'>",
      "contentMix": "<e.g. '80% photos, 15% carousels, 5% reels'>",
      "verdict": "<1-2 punchy sentences>",
      "topIssues": [
        "<specific issue 1>",
        "<specific issue 2>",
        "<specific issue 3>"
      ]
    },
    "3_competitorAnalysis": {
      "title": "Your Top 5 Competitors",
      "competitors": [
        {
          "name": "<real or plausible competitor name>",
          "handle": "<their IG handle>",
          "followers": "<estimated>",
          "postsPerWeek": "<estimated>",
          "whatTheyDoBetter": "<1 sentence>",
          "theirWeakness": "<1 sentence>"
        },
        {
          "name": "<competitor 2>",
          "handle": "<handle>",
          "followers": "<est>",
          "postsPerWeek": "<est>",
          "whatTheyDoBetter": "<1 sentence>",
          "theirWeakness": "<1 sentence>"
        },
        {
          "name": "<competitor 3>",
          "handle": "<handle>",
          "followers": "<est>",
          "postsPerWeek": "<est>",
          "whatTheyDoBetter": "<1 sentence>",
          "theirWeakness": "<1 sentence>"
        }
      ],
      "verdict": "<1-2 punchy sentences comparing them to their top competitor>"
    },
    "4_contentStrategy": {
      "title": "Content That Works in Your Niche",
      "topFormats": ["<format 1>", "<format 2>", "<format 3>"],
      "topHashtags": ["<tag1>", "<tag2>", "<tag3>", "<tag4>", "<tag5>"],
      "bestPostingTimes": "<specific times>",
      "contentCalendar": [
        "<Monday: specific content type>",
        "<Wednesday: specific content type>",
        "<Friday: specific content type>",
        "<Saturday: specific content type>"
      ],
      "verdict": "<1-2 punchy sentences>"
    },
    "5_reviewReputation": {
      "title": "Reviews & Reputation",
      "googleRating": "<X.X / 5.0 — estimated or from search data>",
      "googleReviews": "<count>",
      "competitorAvgRating": "<X.X>",
      "competitorAvgReviews": "<count>",
      "sentiment": "<1 sentence about review sentiment>",
      "verdict": "<1-2 punchy sentences>"
    },
    "6_websiteAudit": {
      "title": "Website Quick Scan",
      "hasWebsite": <true/false>,
      "estimatedSpeed": "<fast/average/slow>",
      "mobileOptimized": "<likely yes/no/unknown>",
      "bookingEase": "<1 sentence about how easy it is to convert>",
      "verdict": "<1-2 punchy sentences>"
    },
    "7_adIntelligence": {
      "title": "Advertising Landscape",
      "competitorAdSpend": "<estimated monthly spend range in this market>",
      "topAdFormats": "<what types of ads work in this niche>",
      "yourOpportunity": "<1-2 sentences about organic vs paid opportunity>",
      "verdict": "<1-2 punchy sentences>"
    },
    "8_revenueOpportunity": {
      "title": "Money You're Leaving on the Table",
      "currentEstimate": "<current estimated monthly revenue from social>",
      "potentialEstimate": "<what they could make>",
      "gap": "<the dollar gap>",
      "calculation": "<1-2 sentences showing the math>",
      "verdict": "<1-2 punchy, FOMO-inducing sentences>"
    },
    "9_aiReadiness": {
      "title": "AI Readiness Score",
      "score": <1-10>,
      "maxScore": 10,
      "automatable": [
        "<task AI can automate 1>",
        "<task AI can automate 2>",
        "<task AI can automate 3>",
        "<task AI can automate 4>",
        "<task AI can automate 5>"
      ],
      "hoursPerWeek": "<hours AI would save>",
      "verdict": "<1-2 punchy sentences>"
    },
    "10_actionPlan": {
      "title": "Your 30-Day Action Plan",
      "week1": [
        "<specific actionable task>",
        "<specific actionable task>",
        "<specific actionable task>"
      ],
      "week2": [
        "<specific actionable task>",
        "<specific actionable task>",
        "<specific actionable task>"
      ],
      "week3": [
        "<specific actionable task>",
        "<specific actionable task>",
        "<specific actionable task>"
      ],
      "week4": [
        "<specific actionable task>",
        "<specific actionable task>",
        "<specific actionable task>"
      ]
    }
  }
}

CRITICAL RULES:
- Be SPECIFIC. Name REAL competitor businesses and brands in their niche and city. Don't say "Competitor A" — say "Radiance Aesthetics" or "Smith & Associates Law".
- Use REAL industry benchmarks. Cite actual engagement rates, posting frequencies, and revenue numbers for their niche.
- The 30-day action plan must be IMMEDIATELY actionable — specific enough that they could start today.
- Verdicts should be brutally honest but motivating. Make them feel the urgency without being insulting.
- Revenue calculations should show real math (average client value × leads × conversion rate).
- If you have Google search data, reference it directly. If not, use your knowledge of the industry.
- DO NOT be generic. Every section should feel personally written for THIS business.
- Keep verdicts to 1-2 SHORT punchy sentences. No fluff.
- The overall score should reflect reality: most small businesses that aren't investing in social media should score 25-55.
- Be CONCISE. Each finding should be 1 short sentence. Total response should be under 3000 tokens.
- For topHashtags, always use strings with the # included and properly quoted: ["#tag1", "#tag2"]`;
}

// ─── CALL OPENROUTER ─────────────────────────────────────────────
async function callOpenRouter(systemPrompt, handle, apiKey) {
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://ascendagency.xyz',
    'X-Title': 'Ascend AI Business Intelligence',
  };

  const body = {
    model: PRIMARY_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Generate the full business intelligence report for @${handle}. Return only the JSON object.` },
    ],
    max_tokens: 4000,
    temperature: 0.3,
  };

  let resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // Fallback to Claude if DeepSeek fails
  if (!resp.ok) {
    body.model = FALLBACK_MODEL;
    body.max_tokens = 4000;
    resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from AI');

  // Robust JSON extraction + repair
  let cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in response');
  let jsonStr = cleaned.slice(start, end + 1);

  // Fix common LLM JSON issues
  // 1. Unquoted hashtags: [#medspa, #glowup] → ["#medspa", "#glowup"]
  jsonStr = jsonStr.replace(/(?<=[\[,])\s*#(\w+)/g, ' "#$1"');
  // 2. Trailing commas before ] or }
  jsonStr = jsonStr.replace(/,\s*([\]}])/g, '$1');
  // 3. Single quotes → double quotes (but not inside strings)
  // 4. Unquoted values that aren't true/false/null/numbers
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Second attempt: more aggressive repair
    // Fix any remaining unquoted string values
    jsonStr = jsonStr.replace(/:\s*([a-zA-Z][a-zA-Z0-9_ ]*?)(\s*[,}\]])/g, (m, val, end) => {
      if (['true', 'false', 'null'].includes(val.trim())) return m;
      return `: "${val.trim()}"${end}`;
    });
    return JSON.parse(jsonStr);
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

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
      const cacheKey = `report:${cleanHandle}:${niche}`;

      // Check cache
      const cached = await getCached(cacheKey, env);
      if (cached) {
        return new Response(JSON.stringify({ ...cached, cached: true }), {
          status: 200,
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }

      // Stage 1: Google search (if Serper key available)
      let searchResults1 = null;
      let searchResults2 = null;

      if (env.SERPER_API_KEY) {
        const nicheLabel = {
          medspa: 'med spa', dental: 'dentist', chiro: 'chiropractor',
          realestate: 'real estate', law: 'law firm', restaurant: 'restaurant',
          gym: 'gym fitness', salon: 'salon', other: 'business',
        }[niche] || 'business';

        // Parallel Google searches
        [searchResults1, searchResults2] = await Promise.all([
          searchGoogle(`"${cleanHandle}" instagram ${nicheLabel}`, env.SERPER_API_KEY),
          searchGoogle(`best ${nicheLabel} instagram competitors ${new Date().getFullYear()}`, env.SERPER_API_KEY),
        ]);
      }

      const searchContext = extractSearchContext(searchResults1, searchResults2);

      // Stage 2: AI analysis
      const systemPrompt = buildSystemPrompt(cleanHandle, niche, searchContext);
      const report = await callOpenRouter(systemPrompt, cleanHandle, env.OPENROUTER_API_KEY);

      // Stage 3: Return + cache
      const result = {
        ...report,
        generatedAt: new Date().toISOString(),
        cached: false,
        searchDataUsed: !!(searchResults1 || searchResults2),
      };

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
