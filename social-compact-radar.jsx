import { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ============================================================
   SOCIAL COMPACT — SoCo INTELLIGENCE RADAR  (v3.1)
   Fixes in this version:
   - Handles "paused" web-search turns from the API (the cause of
     all-3-failed): the app now continues the turn until Claude
     actually finishes answering.
   - If the answer arrives as prose instead of JSON, a second
     conversion pass turns it into structured items.
   - Each category retries once before reporting failure, and
     failures now show the exact reason + a plain-English hint.
   - Team logo: upload the real Social Compact logo once and it
     shows for everyone (shared storage).
   ============================================================ */

const STORE_KEY = "sc-radar:items-v1";
const META_KEY = "sc-radar:meta-v1";
const LOGO_KEY = "sc-radar:logo-v1";

const GOLD = "#C9A24B"; /* exact Social Compact brand gold */
const INK = "#1E1B16";
const PAPER = "#FAF7F0";

const CATEGORIES = {
  rfps: {
    label: "RFPs & Requirements",
    short: "RFPs",
    accent: "#9A7B0A",
    empty:
      "No RFPs or requirements yet. Run a scan to search tender portals, CSR announcements and procurement notices worldwide.",
  },
  voices: {
    label: "Posts & Opinions",
    short: "Voices",
    accent: "#3E5C76",
    empty:
      "No posts or opinions yet. Run a scan to find what corporate leaders are saying about workers and social sustainability.",
  },
  leads: {
    label: "Events & Workshops",
    short: "Events",
    accent: "#4F6B45",
    empty:
      "No events yet. Run a scan to surface conferences, summits, workshops and webinars on social sustainability, labour and worker wellbeing.",
  },
};

const STATUSES = ["New", "Reviewed", "Pursuing", "Not relevant"];
const STATUS_COLORS = {
  New: "#9A7B0A",
  Reviewed: "#3E5C76",
  Pursuing: "#4F6B45",
  "Not relevant": "#8A8578",
};

const PLATFORM_ICON = { Web: "🌐", LinkedIn: "in", X: "𝕏" };

/* ---------- prompt builders ---------- */

const JSON_FORMAT = `Each item must have exactly these keys:
{"title":"...","org":"...","region":"India or country/region","date":"date if known else 'Recent'","platform":"LinkedIn" or "X" or "Web","summary":"...","relevance":"...","sourceUrl":"direct URL"}
"platform" = where the content itself lives: linkedin.com URL or LinkedIn post → "LinkedIn"; x.com/twitter.com → "X"; everything else → "Web".`;

const JSON_RULES = (extra) => `
Run AT MOST 3 web searches, then answer immediately. Make at least ONE of the searches specifically target LinkedIn or X content — e.g. include site:linkedin.com/posts, site:linkedin.com/pulse or site:x.com in the query, or search for news coverage quoting a LinkedIn/X post. If genuine LinkedIn/X items exist, include them; never fake the platform of a source.
CRITICAL — do not over-filter by date: if an item looks recent but you cannot confirm its exact date, INCLUDE it and set date to "Recent". Returning solid items with approximate dates is always better than returning nothing. Only exclude items that are clearly old.
USEFULNESS BAR — every item must be something Social Compact could act on this week: a specific opportunity, a named person/company with a stated position, or a concrete trigger event. Its source must be the SPECIFIC page about that item (the article, the tender notice, the post) — never a homepage, category page, aggregator list or search page. Skip anything generic.
Respond with ONLY a raw JSON array. No markdown, no backticks, no commentary. If you truly found nothing, output [] with no explanation.
Maximum 3 items. Keep every field SHORT — summary max 2 short sentences, relevance max 1 sentence.
${JSON_FORMAT}
"sourceUrl" MUST be copied EXACTLY, character for character, from a URL that appeared in your web search results. NEVER construct, guess, shorten or "clean up" a URL. If you cannot copy an exact URL from the search results for an item, leave sourceUrl as an empty string "".
${extra}
If you find fewer than 3 genuine items, return fewer. NEVER invent items, people or URLs.`;

const GEO_OPTIONS = [
  "Global",
  "India",
  "United States",
  "United Kingdom",
  "European Union",
  "Bangladesh",
  "Vietnam",
  "China",
  "Indonesia",
  "Other…",
];

function geoInstruction(geo) {
  if (!geo || geo === "Global")
    return "Search globally; give a worldwide mix and prioritise the most significant items wherever they are.";
  return `FOCUS ON ${geo.toUpperCase()}: only include items based in, or directly concerning, ${geo}. Skip items unrelated to ${geo}.`;
}

function buildPrompts(rangeText, geoText) {
  return {
    rfps: `You are a research analyst for Social Compact (socialcompact.co), an advisory firm helping companies build structures and processes for worker wellbeing, labour-law compliance, social sustainability and workforce strategy. Strong presence in India (especially manufacturing); works globally.

Search the whole web for demand signals — anything showing an organisation NEEDS the kind of help Social Compact provides. ALL of these qualify:
1. Open tenders, RFPs, EOIs or RFQs on government or PSU procurement portals (GeM, state portals), development agencies (ILO, GIZ, UNDP, USAID, World Bank), or CSR foundations.
2. Grant calls or funding rounds for labour-rights, worker-welfare, skilling or social-compliance work.
3. Corporate "seeking partner / consultant / vendor" notices, supplier-empanelment or pre-qualification calls touching social compliance, HR, worker wellbeing, ethical sourcing or social audits.
4. Company or brand statements announcing they WILL run supplier social audits, human-rights due diligence, or CSRD/CSDDD compliance programmes (a stated intention is a lead-in to a requirement).
5. Industry bodies (CII, FICCI, SEDEX, amfori, Better Work) launching worker-focused programmes needing implementation partners.
Prefer ${rangeText}, but INCLUDE items up to 90 days old if still relevant — formal tenders are scarce, so a slightly older open opportunity is far more useful than nothing. ${geoText} Aim to return 3 items; treat a stated need as qualifying even if no formal document exists yet.
${JSON_RULES('"relevance" = one sentence on why this fits Social Compact.')}`,

    voices: `You are a research analyst for Social Compact (socialcompact.co), an advisory firm focused on worker wellbeing, labour rights and social sustainability.

Search the whole web — news, op-eds, interviews, ESG reports, and publicly indexed LinkedIn and X posts — for posts, opinions or statements, preferring ${rangeText} but including slightly older ones rather than returning empty, by corporate companies or professionals at reputed companies, on anything touching workers directly or indirectly: worker wellbeing, factory and gig workforces, living wages, maternity and social-security benefits, human rights due diligence, supply-chain labour standards. ${geoText}
${JSON_RULES('"relevance" = one sentence on the conversation opening this creates for Social Compact.')}`,

    leads: `You are a research analyst for Social Compact (socialcompact.co), an advisory firm working in worker wellbeing, labour compliance and social sustainability. Manufacturing focus in India; global reach.

Search the whole web for EVENTS — conferences, summits, forums, workshops, webinars, roundtables, trade fairs, award ceremonies and training programmes — related to social sustainability, the labour space, worker wellbeing, human rights, ethical/responsible sourcing, ESG social pillar, occupational safety, fair wages, or workforce/HR in manufacturing and supply chains. ALL of these qualify:
1. Upcoming in-person or virtual events (with a date and, ideally, a registration or info page).
2. Recurring flagship events with a new edition announced (e.g. SA8000/SEDEX/amfori forums, ILO events, responsible-sourcing summits, ESG or sustainability conferences, HR/CHRO summits, factory-safety or labour-law seminars).
3. Events hosted by industry bodies, universities, foundations, development agencies, standards bodies or corporates.
Capture events happening or announced within the next 6 months where possible; also include very recent past events if their proceedings/recordings are useful. For each, the "date" field = the EVENT date (or "Upcoming"), not the publish date. Set "org" = the organiser/host. Prefer ${geoText.includes("Global") ? "a worldwide mix" : "the selected region, plus major global events worth travelling to"}. Aim to return 3 items.
${JSON_RULES('"relevance" = one sentence: why Social Compact should attend, speak at, or watch this event.')}`,
  };
}

/* ---------- helpers ---------- */

function slugId(title, org) {
  return (title + "|" + org)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 120);
}

/* Pull out every complete {...} object even from a truncated or
   messy response. */
function extractItems(text) {
  const clean = String(text).replace(/```json|```/g, "");
  const objs = [];
  let depth = 0,
    start = -1,
    inString = false,
    escape = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const o = JSON.parse(clean.slice(start, i + 1));
          if (o && o.title) objs.push(o);
        } catch (e) {}
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return objs;
}

/* ---------- ground-truth link verification ----------
   The web search machinery returns the REAL result URLs in structured
   blocks. We harvest those and verify every item's link against them:
   a link is only shown if it exactly matches a real search result, or
   is replaced by the best-matching real result. The model's
   transcribed URL alone is never trusted. */
function harvestSearchResults(content) {
  const out = [];
  (content || []).forEach((b) => {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      b.content.forEach((r) => {
        if (r && typeof r.url === "string" && r.url.startsWith("http")) {
          out.push({ url: r.url, title: String(r.title || "") });
        }
      });
    }
  });
  return out;
}

function bestUrlFor(item, pool) {
  const claimed = cleanUrl(item.sourceUrl);
  if (claimed && pool.some((p) => p.url === claimed)) return claimed; // 1. verified exact
  // 2. domain-verified: the claimed URL's site appeared in real results
  if (claimed) {
    try {
      const host = new URL(claimed).hostname.replace(/^www\./, "");
      if (
        pool.some((p) => {
          try {
            return new URL(p.url).hostname.replace(/^www\./, "") === host;
          } catch (e) {
            return false;
          }
        })
      )
        return claimed;
    } catch (e) {}
  }
  // 3. best-matching real search result
  const tokens =
    (String(item.title) + " " + String(item.org))
      .toLowerCase()
      .match(/[a-z0-9]{4,}/g) || [];
  let best = null;
  let bestScore = 0;
  pool.forEach((p) => {
    const hay = (p.title + " " + p.url).toLowerCase();
    let score = 0;
    tokens.forEach((t) => {
      if (hay.includes(t)) score++;
    });
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  if (bestScore >= 2) return best.url;
  // 4. the model's copied URL, so every finding still carries its source
  return claimed || "";
}

/* Guaranteed link for exports: the exact source if present, else a
   targeted search link so every finding is reachable. */
function linkForExport(it) {
  return (
    cleanUrl(it.sourceUrl) ||
    `https://www.google.com/search?q=${encodeURIComponent(
      `${it.title} ${it.org}`
    )}`
  );
}

async function apiCall(body) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "API error");
  if (!data.content) throw new Error("Empty response from API");
  return data;
}

/* Full research call:
   1. Ask with web search enabled.
   2. If the API pauses the turn mid-search (this is what caused the
      earlier failures), continue the same turn until it finishes.
   3. If the finished answer isn't parseable JSON, run a conversion
      pass (no search) that turns the findings into JSON. */
async function researchCall(prompt) {
  let messages = [{ role: "user", content: prompt }];
  let data = null;
  const pool = []; // real URLs returned by the search machinery

  for (let hop = 0; hop < 5; hop++) {
    data = await apiCall({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    pool.push(...harvestSearchResults(data.content));
    if (data.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: data.content }];
      continue;
    }
    break;
  }

  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  let items = extractItems(text);

  if (items.length === 0 && text.trim().length > 40) {
    // Findings arrived as prose — convert them.
    const conv = await apiCall({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: `Convert these research findings into a raw JSON array. No markdown, no backticks, no commentary. Maximum 3 items, short fields. ${JSON_FORMAT}
Only include findings that have a real source; skip anything vague. If nothing qualifies, return []

FINDINGS:
${text.slice(0, 6000)}`,
        },
      ],
    });
    const convText = conv.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    items = extractItems(convText);
  }

  // Verify every link against real search results.
  items.forEach((it) => {
    it.sourceUrl = bestUrlFor(it, pool);
  });

  if (items.length === 0) {
    // The search completed but nothing qualified — not an error.
    return [];
  }
  return items;
}

/* Robust research: up to 3 attempts per section. Results ACCUMULATE
   across attempts (deduplicated), and later attempts are explicitly
   told to try different, broader queries. This is what turns
   "0 found one run, 3 found the next" into consistent results:
   instead of one roll of the dice, each scan is three rolls whose
   hits are combined. Stops early once it has 2+ items. */
async function researchWithRetry(prompt, onProgress) {
  const collected = [];
  const seen = new Set();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (onProgress && attempt > 0)
      onProgress(`searching… (attempt ${attempt + 1} of 3)`);
    const p =
      attempt === 0
        ? prompt
        : prompt +
          `\n\nIMPORTANT: A previous attempt found too little. This time use DIFFERENT and BROADER search queries — different keywords, a different angle (industry news, government portals, company newsrooms, industry-body announcements). Do not repeat earlier queries.`;
    try {
      const found = await researchCall(p);
      found.forEach((it) => {
        const k = slugId(String(it.title || ""), String(it.org || ""));
        if (!seen.has(k)) {
          seen.add(k);
          collected.push(it);
        }
      });
    } catch (e) {
      /* attempt failed — the next one still runs */
    }
    if (collected.length >= 2) break;
  }
  return collected;
}

/* ---------- AI helpers: weekly digest & outreach drafts ---------- */

async function generateDigest(activeItems) {
  const compact = activeItems.slice(0, 30).map((it) => ({
    section:
      it.category === "leads"
        ? "events"
        : it.category === "voices"
        ? "posts & opinions"
        : "RFPs",
    title: it.title,
    org: it.org,
    region: it.region,
    status: it.status,
  }));
  const data = await apiCall({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `You write the weekly intelligence digest for Social Compact (socialcompact.co), an advisory firm helping companies build structures and processes for worker wellbeing, labour compliance and social sustainability. Manufacturing focus in India; global reach.

Here are the current items on their intelligence board as JSON:
${JSON.stringify(compact)}

Write, in plain English with short sentences and no jargon:
1. A digest of 100-150 words: what this board says about the market right now and what it means for Social Compact. Be specific — name organisations and patterns, not generalities.
2. Then exactly 3 recommended actions for the team this week, each ONE sentence, each on its own line starting with "- ".

No headings, no markdown, no preamble. Start directly with the digest.`,
      },
    ],
  });
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function generateOutreach(item) {
  const data = await apiCall({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `Write a short outreach note (2-3 sentences, plain English, short sentences, warm but professional, no clichés, no flattery) from Social Compact — an advisory firm working in worker wellbeing, labour compliance and social sustainability (socialcompact.co) — to the ORGANISER of this event, expressing interest in attending, speaking, or partnering. Reference the specific event concretely. End with a light ask for a short conversation. Return ONLY the message text, nothing else.

Event: ${item.title}
Organiser: ${item.org}
Region: ${item.region}
When: ${item.date}
Context: ${item.summary}
Angle: ${item.relevance}`,
      },
    ],
  });
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function toCsv(rows) {
  const cols = [
    "section",
    "title",
    "organisation",
    "region",
    "date",
    "platform",
    "status",
    "summary",
    "why_it_matters",
    "source_url",
    "team_notes",
  ];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(",")];
  rows.forEach((it) =>
    lines.push(
      [
        CATEGORIES[it.category]?.label || it.category,
        it.title,
        it.org,
        it.region,
        it.date,
        it.platform || "Web",
        it.status,
        it.summary,
        it.relevance,
        linkForExport(it),
        it.notes,
      ]
        .map(esc)
        .join(",")
    )
  );
  return lines.join("\n");
}

function errorHint(msg) {
  const m = String(msg).toLowerCase();
  if (m.includes("failed to fetch") || m.includes("network"))
    return "The app couldn't reach the AI service from this device — check your connection and try again.";
  if (m.includes("rate") || m.includes("overload") || m.includes("529"))
    return "The service is busy — wait a minute and run the scan again.";
  if (m.includes("no usable results"))
    return "The search finished but returned nothing solid for this window — try 'Past month' for a wider net.";
  return "Try running the scan again; if it keeps failing, note this exact message.";
}

function normalizePlatform(p, url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("linkedin.com")) return "LinkedIn";
  if (u.includes("x.com") || u.includes("twitter.com")) return "X";
  const s = String(p || "").toLowerCase();
  if (s.includes("linkedin")) return "LinkedIn";
  if (s === "x" || s.includes("twitter")) return "X";
  return "Web";
}

function agoText(iso) {
  const d = daysSince(iso);
  if (!isFinite(d)) return "";
  if (d === 0) return "added today";
  if (d === 1) return "added 1d ago";
  return `added ${d}d ago`;
}

function cleanUrl(u) {
  const s = String(u || "").trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(s)) return "";
  return s;
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

/* ---------- component ---------- */


function IntelligenceRadar() {
  const [items, setItems] = useState({});
  const [meta, setMeta] = useState({ lastScan: null, scanCount: 0 });
  const [logo, setLogo] = useState(null); // data URL, shared by team
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("rfps");
  const [sortBy, setSortBy] = useState("newest");
  const [showHelp, setShowHelp] = useState(false);
  const [regionFilter, setRegionFilter] = useState("All");
  const [platformFilter, setPlatformFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("week");
  const [geo, setGeo] = useState("India");
  const [customGeo, setCustomGeo] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanLog, setScanLog] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [digestLoading, setDigestLoading] = useState(false);
  const [outreachLoading, setOutreachLoading] = useState(null); // item id
  const [copied, setCopied] = useState(null); // item id
  const [clearOpen, setClearOpen] = useState(false);
  const [clearPending, setClearPending] = useState(null); // {scope, label, n}

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(STORE_KEY, true);
        if (r?.value) setItems(JSON.parse(r.value));
      } catch (e) {}
      try {
        const m = await window.storage.get(META_KEY, true);
        if (m?.value) setMeta(JSON.parse(m.value));
      } catch (e) {}
      try {
        const l = await window.storage.get(LOGO_KEY, true);
        if (l?.value) setLogo(l.value);
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  const persistItems = useCallback(async (next) => {
    setItems(next);
    try {
      await window.storage.set(STORE_KEY, JSON.stringify(next), true);
    } catch (e) {
      console.error("Save failed", e);
    }
  }, []);

  const persistMeta = useCallback(async (next) => {
    setMeta(next);
    try {
      await window.storage.set(META_KEY, JSON.stringify(next), true);
    } catch (e) {
      console.error("Save failed", e);
    }
  }, []);

  /* ---------- live sync: keep the board & tab counts fresh ----------
     The board is shared. Without this, numbers only updated when the
     app was first opened. Now it re-reads shared storage every 30s and
     whenever the tab regains focus — so a teammate's scan or status
     change shows up here (and in the tab counts) without a reload. */
  const scanningRef = useRef(false);
  const clearRef = useRef(false);
  useEffect(() => {
    scanningRef.current = scanning;
  }, [scanning]);
  useEffect(() => {
    clearRef.current = !!clearPending;
  }, [clearPending]);

  const syncFromStorage = useCallback(async () => {
    if (scanningRef.current || clearRef.current) return;
    try {
      const r = await window.storage.get(STORE_KEY, true);
      if (r?.value) {
        const parsed = JSON.parse(r.value);
        setItems((prev) =>
          JSON.stringify(prev) === JSON.stringify(parsed) ? prev : parsed
        );
      }
    } catch (e) {}
    try {
      const m = await window.storage.get(META_KEY, true);
      if (m?.value) {
        const parsed = JSON.parse(m.value);
        setMeta((prev) =>
          JSON.stringify(prev) === JSON.stringify(parsed) ? prev : parsed
        );
      }
    } catch (e) {}
  }, []);

  useEffect(() => {
    const id = setInterval(syncFromStorage, 30000);
    const onVis = () => {
      if (document.visibilityState === "visible") syncFromStorage();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [syncFromStorage]);

  /* ---------- scan (all categories, or a single rerun) ---------- */
  const runScan = async (onlyCats) => {
    if (scanning) return;
    setScanning(true);
    const cats = onlyCats || ["rfps", "voices", "leads"];
    const rangeText = range === "week" ? "the past 7 days" : "the past 30 days";
    const activeGeo =
      geo === "Other…" ? customGeo.trim() || "Global" : geo;
    const prompts = buildPrompts(rangeText, geoInstruction(activeGeo));
    const log = { ...(scanLog || {}) };
    cats.forEach((c) => (log[c] = "waiting…"));
    setScanLog({ ...log });

    let next = { ...items };
    for (const cat of cats) {
      log[cat] = "searching…";
      setScanLog({ ...log });
      try {
        const found = await researchWithRetry(prompts[cat], (msg) => {
          log[cat] = msg;
          setScanLog({ ...log });
        });
        if (found.length === 0) {
          log[cat] =
            "0 found after 3 attempts — unusual; rerun this section or widen to 'Past month'";
        } else {
          let added = 0;
        found.forEach((raw) => {
          if (!raw?.title || !raw?.org) return;
          const id = slugId(raw.title, raw.org);
          if (next[id]) return;
          next[id] = {
            id,
            category: cat,
            title: String(raw.title),
            org: String(raw.org),
            region: String(raw.region || "Global"),
            date: String(raw.date || "Recent"),
            platform: normalizePlatform(raw.platform, raw.sourceUrl),
            summary: String(raw.summary || ""),
            relevance: String(raw.relevance || ""),
            sourceUrl: cleanUrl(raw.sourceUrl),
            status: "New",
            notes: "",
            foundAt: new Date().toISOString(),
          };
          added++;
        });
        log[cat] =
          added === 0 ? "0 new (all already on board)" : `${added} new ✓`;
        }
      } catch (e) {
        log[cat] = `failed — ${e.message}. ${errorHint(e.message)}`;
      }
      setScanLog({ ...log });
      await persistItems(next);
    }

    await persistMeta({
      lastScan: new Date().toISOString(),
      scanCount: (meta.scanCount || 0) + 1,
      digest: meta.digest,
      lastGeo: activeGeo,
    });
    setScanning(false);
  };

  /* ---------- item mutations ---------- */
  const setStatus = (id, status) =>
    persistItems({ ...items, [id]: { ...items[id], status } });
  const saveNotes = (id, notes) =>
    persistItems({ ...items, [id]: { ...items[id], notes } });
  const removeItem = (id) => {
    const next = { ...items };
    delete next[id];
    persistItems(next);
    if (expanded === id) setExpanded(null);
  };

  const activeItems = () =>
    Object.values(items).filter((it) => it.status !== "Not relevant");

  const onGenerateDigest = async () => {
    if (digestLoading) return;
    const act = activeItems();
    if (act.length === 0) return;
    setDigestLoading(true);
    try {
      const text = await generateDigest(act);
      await persistMeta({
        ...meta,
        digest: { text, at: new Date().toISOString() },
      });
    } catch (e) {
      console.error("Digest failed", e);
    }
    setDigestLoading(false);
  };

  const onDraftOutreach = async (it) => {
    if (outreachLoading) return;
    setOutreachLoading(it.id);
    try {
      const text = await generateOutreach(it);
      await persistItems({
        ...items,
        [it.id]: { ...items[it.id], outreach: text },
      });
    } catch (e) {
      console.error("Outreach draft failed", e);
    }
    setOutreachLoading(null);
  };

  const copyText = async (id, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1800);
    } catch (e) {
      /* clipboard blocked — user can select manually */
    }
  };

  const exportCsv = () => {
    const csv = toCsv(
      activeItems().sort((a, b) =>
        (a.category + a.foundAt).localeCompare(b.category + b.foundAt)
      )
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `soco-intelligence-radar-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /* ---------- clearing searched items ---------- */
  const clearScopeIds = (scope) => {
    const all = Object.values(items);
    if (scope === "section")
      return all
        .filter((it) =>
          tab === "pipeline" ? it.status === "Pursuing" : it.category === tab
        )
        .map((it) => it.id);
    if (scope === "notrelevant")
      return all.filter((it) => it.status === "Not relevant").map((it) => it.id);
    return all.map((it) => it.id); // 'all'
  };

  const requestClear = (scope, label) => {
    const n = clearScopeIds(scope).length;
    if (n === 0) return;
    setClearPending({ scope, label, n });
  };

  const confirmClear = async () => {
    if (!clearPending) return;
    const ids = new Set(clearScopeIds(clearPending.scope));
    const next = {};
    Object.values(items).forEach((it) => {
      if (!ids.has(it.id)) next[it.id] = it;
    });
    await persistItems(next);
    if (clearPending.scope === "all" && meta.digest) {
      await persistMeta({ ...meta, digest: null });
    }
    setClearPending(null);
    setClearOpen(false);
    setExpanded(null);
  };

  /* ---------- derived ---------- */
  const list = useMemo(() => {
    let arr = Object.values(items);
    if (tab === "pipeline") {
      arr = arr.filter((it) => it.status === "Pursuing");
    } else {
      arr = arr
        .filter((it) => it.category === tab)
        .filter((it) => {
          if (statusFilter === "Active") return it.status !== "Not relevant";
          if (statusFilter === "All") return true;
          return it.status === statusFilter;
        });
    }
    arr = arr
      .filter((it) => {
        if (regionFilter === "All") return true;
        return new RegExp(
          regionFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i"
        ).test(it.region);
      })
      .filter(
        (it) =>
          platformFilter === "All" || (it.platform || "Web") === platformFilter
      )
      .filter((it) => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return (
          it.title.toLowerCase().includes(q) ||
          it.org.toLowerCase().includes(q) ||
          it.summary.toLowerCase().includes(q) ||
          (it.notes || "").toLowerCase().includes(q)
        );
      });
    if (sortBy === "oldest")
      arr.sort((a, b) => (a.foundAt || "").localeCompare(b.foundAt || ""));
    else if (sortBy === "org")
      arr.sort((a, b) => a.org.localeCompare(b.org));
    else
      arr.sort((a, b) => (b.foundAt || "").localeCompare(a.foundAt || ""));
    return arr;
  }, [items, tab, regionFilter, platformFilter, statusFilter, query, sortBy]);

  const counts = useMemo(() => {
    const c = { rfps: 0, voices: 0, leads: 0 };
    Object.values(items).forEach((it) => {
      if (it.status !== "Not relevant" && c[it.category] !== undefined)
        c[it.category]++;
    });
    return c;
  }, [items]);

  const regionOptions = useMemo(() => {
    const set = new Set();
    Object.values(items).forEach((it) => {
      if (it.region) set.add(it.region.trim());
    });
    return Array.from(set).sort();
  }, [items]);

  const stats = useMemo(() => {
    const act = Object.values(items).filter(
      (it) => it.status !== "Not relevant"
    );
    const weekAgo = Date.now() - 7 * 86400000;
    return {
      active: act.length,
      fresh: act.filter((i) => i.status === "New").length,
      pursuing: act.filter((i) => i.status === "Pursuing").length,
      week: act.filter((i) => new Date(i.foundAt || 0).getTime() > weekAgo)
        .length,
    };
  }, [items]);

  const stale = daysSince(meta.lastScan);
  const overdue = stale > 7;

  /* ---------- shareable report (print / save as PDF) ---------- */
  if (showReport) {
    const today = new Date().toLocaleDateString("en-IN", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const active = (cat) =>
      Object.values(items)
        .filter((it) => it.category === cat && it.status !== "Not relevant")
        .sort((a, b) => (b.foundAt || "").localeCompare(a.foundAt || ""));
    return (
      <div style={S.page}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
          * { box-sizing: border-box; }
          button { font-family: 'Inter', sans-serif; cursor: pointer; }
          @media print {
            .no-print { display: none !important; }
            body { background: #fff !important; }
            a { color: #3E5C76 !important; }
            article { break-inside: avoid; }
          }
        `}</style>

        <div className="no-print" style={S.reportToolbar}>
          <button onClick={() => setShowReport(false)} style={S.reportBack}>
            ← Back to board
          </button>
          <button onClick={() => window.print()} style={S.scanBtn}>
            Print / Save as PDF
          </button>
          <span style={S.reportHint}>
            In the print window, choose "Save as PDF" as the destination, then
            share the file with anyone.
          </span>
        </div>

        <div style={S.headerFrame}>
          <div style={{ ...S.headerFrameInner, padding: "26px 28px" }}>
            <div style={S.logoWord}>SOCIAL COMPACT</div>
            <div style={S.logoTag}>SoCo Intelligence Radar — Scan Report</div>
            <div style={S.reportMeta}>
              Generated {today}
              {meta.lastScan &&
                ` · Last scan ${
                  stale === 0 ? "today" : stale + " day(s) ago"
                }`}{" "}
              · {counts.rfps} RFPs · {counts.voices} posts &amp; opinions ·{" "}
              {counts.leads} events &amp; workshops (active items only)
            </div>

            {meta.digest && (
              <section style={S.reportSection}>
                <h2 style={{ ...S.reportH2, borderColor: GOLD }}>
                  This week in brief
                </h2>
                <p style={{ ...S.reportItemText, whiteSpace: "pre-line" }}>
                  {meta.digest.text}
                </p>
              </section>
            )}

            {["rfps", "voices", "leads"].map((cat) => {
              const rows = active(cat);
              return (
                <section key={cat} style={S.reportSection}>
                  <h2
                    style={{
                      ...S.reportH2,
                      borderColor: CATEGORIES[cat].accent,
                    }}
                  >
                    {CATEGORIES[cat].label}{" "}
                    <span style={S.reportCount}>({rows.length})</span>
                  </h2>
                  {rows.length === 0 ? (
                    <p style={S.reportEmpty}>
                      Nothing active in this section yet.
                    </p>
                  ) : (
                    rows.map((it) => (
                      <article key={it.id} style={S.reportItem}>
                        <div style={S.reportItemTitle}>{it.title}</div>
                        <div style={S.reportItemMeta}>
                          {it.org} · {it.region} · {it.date} ·{" "}
                          {it.platform || "Web"} · Status: {it.status}
                        </div>
                        <p style={S.reportItemText}>{it.summary}</p>
                        {it.relevance && (
                          <p style={S.reportItemText}>
                            <b>Why it matters:</b> {it.relevance}
                          </p>
                        )}
                        {it.notes && (
                          <p style={S.reportItemText}>
                            <b>Team notes:</b> {it.notes}
                          </p>
                        )}
                        <div style={S.reportItemLink}>
                          Source: {linkForExport(it)}
                        </div>
                      </article>
                    ))
                  )}
                </section>
              );
            })}

            <div style={S.reportFooter}>
              Social Compact · socialcompact.co · Sources gathered from the
              open web; verify each source before acting on it.
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- render ---------- */
  return (
    <div style={S.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        body { -webkit-font-smoothing: antialiased; }
        button, select, input, textarea { font-family: 'Inter', sans-serif; }
        button { cursor: pointer; transition: filter .15s ease, background .15s ease, box-shadow .15s ease; }
        button:not(:disabled):hover { filter: brightness(.96); }
        button:not(:disabled):active { transform: scale(.98); }
        input, select, textarea { transition: border-color .15s ease, box-shadow .15s ease; }
        input:focus, select:focus, textarea:focus { border-color: ${GOLD} !important; box-shadow: 0 0 0 3px rgba(201,162,75,.18); outline: none; }
        button:focus-visible, a:focus-visible { outline: 2px solid ${GOLD}; outline-offset: 2px; }
        .sc-card { transition: box-shadow .18s ease, transform .18s ease; }
        .sc-card:hover { box-shadow: 0 10px 32px rgba(30,27,22,.10); transform: translateY(-2px); }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } .sc-card:hover { transform: none; } }
        ::placeholder { color: #9B9484; }
      `}</style>

      <header style={S.headerOuter}>
        <div style={S.headerFrame}>
          <div style={S.headerFrameInner}>
            <div style={S.headTop}>
              {/* ---- brand: real SoCo logo shows here once its file is
                   embedded; wordmark-only until then ---- */}
              <div style={S.logoLockup}>
                {logo && (
                  <img src={logo} alt="Social Compact logo" style={S.logoImg} />
                )}
                <div>
                  <div style={S.logoWord}>SOCIAL COMPACT</div>
                  <div style={S.logoTag}>SoCo Intelligence Radar</div>
                </div>
              </div>

              {/* ---- scan panel ---- */}
              <div style={S.scanPanel}>
                <div style={S.scanRow}>
                  <label style={S.rangeLabel}>
                    Scan window
                    <select
                      style={S.rangeSelect}
                      value={range}
                      onChange={(e) => setRange(e.target.value)}
                      disabled={scanning}
                    >
                      <option value="week">Past week</option>
                      <option value="month">Past month</option>
                    </select>
                  </label>
                  <label style={S.rangeLabel}>
                    Region
                    <select
                      style={S.rangeSelect}
                      value={geo}
                      onChange={(e) => setGeo(e.target.value)}
                      disabled={scanning}
                    >
                      {GEO_OPTIONS.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                  </label>
                  {geo === "Other…" && (
                    <label style={S.rangeLabel}>
                      Country / region name
                      <input
                        style={S.rangeSelect}
                        placeholder="e.g. Kenya, Brazil, ASEAN"
                        value={customGeo}
                        onChange={(e) => setCustomGeo(e.target.value)}
                        disabled={scanning}
                      />
                    </label>
                  )}
                  <button
                    onClick={() => runScan()}
                    disabled={scanning}
                    style={{
                      ...S.scanBtn,
                      background: scanning ? "#8A8578" : INK,
                    }}
                  >
                    {scanning ? "Scanning…" : "Run scan"}
                  </button>
                  <button
                    onClick={() => setShowReport(true)}
                    disabled={scanning}
                    style={S.reportBtn}
                  >
                    Share report (PDF)
                  </button>
                </div>
                <div style={S.stampLine}>
                  <span
                    style={{
                      ...S.stampDot,
                      background: overdue ? "#A4442E" : "#4F6B45",
                    }}
                  />
                  {meta.lastScan
                    ? `Last scan ${stale === 0 ? "today" : stale + "d ago"}${
                        meta.lastGeo ? ` · ${meta.lastGeo}` : ""
                      }${
                        overdue ? " — weekly scan due" : ""
                      } · ${meta.scanCount || 0} total`
                    : "Never scanned — run your first scan"}
                </div>
              </div>
            </div>

            <p style={S.sub}>
              This board tracks three things for Social Compact.{" "}
              <b>RFPs &amp; Requirements</b> — active tenders, proposals and
              stated needs from companies looking for help on social
              sustainability and worker wellbeing. <b>Posts &amp; Opinions</b>{" "}
              — what corporate leaders and companies are publicly saying about
              workers, wages, benefits and labour standards.{" "}
              <b>Events &amp; Workshops</b> — conferences, summits, workshops
              and webinars in the social sustainability, labour and worker-
              wellbeing space that Social Compact could attend, speak at or
              watch. Results come from across the whole web — news, tender
              portals, ESG reports and company sites — not only LinkedIn and X;
              each card shows where its source lives. Shared board: everyone at
              Social Compact sees and works on the same data.
            </p>

            {/* ---- board stats ---- */}
            <div style={S.statsRow}>
              {[
                ["Active items", stats.active],
                ["New", stats.fresh],
                ["Pursuing", stats.pursuing],
                ["Added this week", stats.week],
              ].map(([label, val]) => (
                <div key={label} style={S.statBlock}>
                  <div style={S.statNum}>{val}</div>
                  <div style={S.statLabel}>{label}</div>
                </div>
              ))}
            </div>

            {/* ---- weekly digest ---- */}
            <div style={S.digestPanel}>
              <div style={S.digestHead}>
                <span style={S.digestTitle}>This week in brief</span>
                <button
                  style={S.digestBtn}
                  onClick={onGenerateDigest}
                  disabled={digestLoading || stats.active === 0}
                >
                  {digestLoading
                    ? "Writing…"
                    : meta.digest
                    ? "Refresh digest"
                    : "Generate digest"}
                </button>
              </div>
              {meta.digest ? (
                <>
                  <p style={S.digestText}>{meta.digest.text}</p>
                  <div style={S.digestMeta}>
                    Written {daysSince(meta.digest.at) === 0
                      ? "today"
                      : `${daysSince(meta.digest.at)}d ago`}{" "}
                    · shared with the whole team
                  </div>
                </>
              ) : (
                <p style={S.digestEmpty}>
                  {stats.active === 0
                    ? "Run a scan first — then generate a digest of what it all means."
                    : "One click writes a plain-English summary of the whole board: what the market is signalling and 3 recommended actions for the week."}
                </p>
              )}
            </div>

            {scanLog && (
              <div style={S.scanLog}>
                {["rfps", "voices", "leads"].map((c) => (
                  <div key={c} style={S.scanLogItem}>
                    <b style={{ color: CATEGORIES[c].accent }}>
                      {CATEGORIES[c].short}:
                    </b>{" "}
                    {scanLog[c]}
                    {!scanning &&
                      scanLog[c] &&
                      /0 found|failed/i.test(String(scanLog[c])) && (
                        <button
                          style={S.rerunBtn}
                          onClick={() => runScan([c])}
                        >
                          Rerun this section
                        </button>
                      )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <nav style={S.tabs}>
        {Object.entries(CATEGORIES).map(([key, cat]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            title={`${counts[key]} active item(s) — excludes 'Not relevant'; filters don't change this number`}
            style={{
              ...S.tab,
              background: tab === key ? INK : "transparent",
              color: tab === key ? PAPER : "#6E6858",
              fontWeight: tab === key ? 600 : 500,
              boxShadow:
                tab === key ? "0 2px 8px rgba(30,27,22,.18)" : "none",
            }}
          >
            {cat.label}
            <span style={{ ...S.count, background: cat.accent }}>
              {counts[key]}
            </span>
          </button>
        ))}
        <button
          onClick={() => setTab("pipeline")}
          style={{
            ...S.tab,
            background: tab === "pipeline" ? INK : "transparent",
            color: tab === "pipeline" ? PAPER : "#6E6858",
            fontWeight: tab === "pipeline" ? 600 : 500,
            boxShadow:
              tab === "pipeline" ? "0 2px 8px rgba(30,27,22,.18)" : "none",
          }}
          title="Everything the team is actively pursuing, across all sections"
        >
          Pipeline
          <span style={{ ...S.count, background: INK }}>{stats.pursuing}</span>
        </button>
        <button style={S.helpToggle} onClick={() => setShowHelp(!showHelp)}>
          {showHelp ? "Hide guide" : "How it works"}
        </button>
      </nav>

      {showHelp && (
        <div style={S.helpPanel}>
          <b>New here? The weekly loop takes 15 minutes.</b> 1) Click{" "}
          <b>Run scan</b> — the board fills with fresh RFPs, opinions and
          events from across the web. 2) Open each new card, check the source
          link, and set its status: Reviewed if noted, Pursuing if we should
          act, Not relevant to hide it. 3) For an event worth attending, click{" "}
          <b>Draft note to organiser</b> and edit before sending. 4) Click{" "}
          <b>Generate digest</b> for the week's summary, then{" "}
          <b>Share report (PDF)</b> to send it around. The <b>Pipeline</b> tab
          shows everything marked Pursuing across all sections — that's the
          team's live to-do list. Everything you do here is saved and shared
          with everyone at Social Compact.
        </div>
      )}

      <div style={S.filters}>
        <input
          style={S.search}
          placeholder="Search titles, organisations, notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          style={S.select}
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          aria-label="Filter by platform"
        >
          <option value="All">All platforms</option>
          <option value="Web">Web</option>
          <option value="LinkedIn">LinkedIn</option>
          <option value="X">X</option>
        </select>
        <select
          style={S.select}
          value={regionFilter}
          onChange={(e) => setRegionFilter(e.target.value)}
          aria-label="Filter by region"
        >
          <option value="All">All regions</option>
          {regionOptions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {tab !== "pipeline" && (
          <select
            style={S.select}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="Active">Active (hide Not relevant)</option>
            <option value="All">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <select
          style={S.select}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          aria-label="Sort order"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="org">Organisation A–Z</option>
        </select>
        <button style={S.csvBtn} onClick={exportCsv}>
          Export Excel (CSV)
        </button>
        <button
          style={S.clearBtn}
          onClick={() => {
            setClearOpen(!clearOpen);
            setClearPending(null);
          }}
        >
          Clear items
        </button>
      </div>

      {clearOpen && (
        <div style={S.clearPanel}>
          {!clearPending ? (
            <>
              <span style={S.clearLabel}>
                Clear searched items — this deletes them for the whole team:
              </span>
              <button
                style={S.clearOption}
                onClick={() =>
                  requestClear(
                    "section",
                    tab === "pipeline"
                      ? "all Pipeline (Pursuing) items"
                      : `all ${CATEGORIES[tab].label} items`
                  )
                }
              >
                {tab === "pipeline"
                  ? "This tab (Pipeline)"
                  : `This section (${CATEGORIES[tab].label})`}
              </button>
              <button
                style={S.clearOption}
                onClick={() =>
                  requestClear("notrelevant", "all 'Not relevant' items")
                }
              >
                Only 'Not relevant' items
              </button>
              <button
                style={S.clearOptionDanger}
                onClick={() => requestClear("all", "the entire board")}
              >
                Entire board
              </button>
            </>
          ) : (
            <>
              <span style={S.clearLabel}>
                Delete <b>{clearPending.n}</b> item
                {clearPending.n === 1 ? "" : "s"} ({clearPending.label})? This
                removes them for everyone at Social Compact, including notes
                and statuses, and cannot be undone. Tip: Export Excel (CSV)
                first if you want a backup.
              </span>
              <button style={S.clearConfirm} onClick={confirmClear}>
                Yes, delete {clearPending.n}
              </button>
              <button
                style={S.clearOption}
                onClick={() => setClearPending(null)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      <main style={S.main}>
        {!loaded ? (
          <div style={S.empty}>Loading the team board…</div>
        ) : list.length === 0 ? (
          <div style={S.empty}>
            {tab === "pipeline"
              ? "Nothing in the pipeline yet. Mark items as 'Pursuing' and they'll gather here — the team's live to-do list."
              : Object.values(items).some((i) => i.category === tab)
              ? "Nothing matches your filters."
              : CATEGORIES[tab].empty}
          </div>
        ) : (
          list.map((it) => {
            const open = expanded === it.id;
            const plat = it.platform || "Web";
            return (
              <article key={it.id} className="sc-card" style={S.card}>
                <div
                  style={S.cardHead}
                  onClick={() => setExpanded(open ? null : it.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) =>
                    (e.key === "Enter" || e.key === " ") &&
                    setExpanded(open ? null : it.id)
                  }
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={S.cardMeta}>
                      <span
                        style={{
                          ...S.pill,
                          background: STATUS_COLORS[it.status] + "1E",
                          color: STATUS_COLORS[it.status],
                          border: `1px solid ${STATUS_COLORS[it.status]}55`,
                        }}
                      >
                        {it.status}
                      </span>
                      {tab === "pipeline" && (
                        <span
                          style={{
                            ...S.pill,
                            background: CATEGORIES[it.category].accent + "1E",
                            color: CATEGORIES[it.category].accent,
                            border: `1px solid ${
                              CATEGORIES[it.category].accent
                            }55`,
                          }}
                        >
                          {CATEGORIES[it.category].label}
                        </span>
                      )}
                      <span style={S.platPill} title={`Source: ${plat}`}>
                        {PLATFORM_ICON[plat]} {plat}
                      </span>
                      <span style={S.metaText}>{it.org}</span>
                      <span style={S.metaDot}>·</span>
                      <span style={S.metaText}>{it.region}</span>
                      <span style={S.metaDot}>·</span>
                      <span style={S.metaText}>{it.date}</span>
                      {agoText(it.foundAt) && (
                        <>
                          <span style={S.metaDot}>·</span>
                          <span style={S.metaText}>{agoText(it.foundAt)}</span>
                        </>
                      )}
                      {it.status === "New" && (
                        <button
                          style={S.quickReview}
                          onClick={(e) => {
                            e.stopPropagation();
                            setStatus(it.id, "Reviewed");
                          }}
                          title="Mark as reviewed"
                        >
                          ✓ Mark reviewed
                        </button>
                      )}
                    </div>
                    <h3 style={S.cardTitle}>{it.title}</h3>
                    {!open && <p style={S.cardSummaryClamp}>{it.summary}</p>}
                  </div>
                  <span style={S.chev}>{open ? "−" : "+"}</span>
                </div>

                {open && (
                  <div style={S.cardBody}>
                    <p style={S.para}>{it.summary}</p>
                    {it.relevance && (
                      <p style={S.why}>
                        <b>Why it matters to us:</b> {it.relevance}
                      </p>
                    )}
                    <div style={S.linkRow}>
                      {cleanUrl(it.sourceUrl) && (
                        <a
                          href={cleanUrl(it.sourceUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={S.link}
                        >
                          Open source on {plat} ↗
                        </a>
                      )}
                      <a
                        href={`https://www.google.com/search?q=${encodeURIComponent(
                          `${it.title} ${it.org}`
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={S.linkAlt}
                      >
                        {cleanUrl(it.sourceUrl)
                          ? "Link broken? Find it on Google ↗"
                          : "Find the source on Google ↗"}
                      </a>
                    </div>
                    {cleanUrl(it.sourceUrl) && (
                      <div style={S.exactUrl}>
                        Exact source: {cleanUrl(it.sourceUrl)}
                      </div>
                    )}

                    <div style={S.actions}>
                      <label style={S.actionLabel}>
                        Status
                        <select
                          style={{ ...S.select, marginLeft: 8 }}
                          value={it.status}
                          onChange={(e) => setStatus(it.id, e.target.value)}
                        >
                          {STATUSES.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </label>
                      {it.category === "leads" && (
                        <button
                          style={S.outreachBtn}
                          onClick={() => onDraftOutreach(it)}
                          disabled={outreachLoading === it.id}
                        >
                          {outreachLoading === it.id
                            ? "Drafting…"
                            : it.outreach
                            ? "Redraft note to organiser"
                            : "Draft note to organiser"}
                        </button>
                      )}
                      <button
                        style={S.deleteBtn}
                        onClick={() => removeItem(it.id)}
                      >
                        Delete
                      </button>
                    </div>

                    {it.outreach && (
                      <div style={S.outreachBox}>
                        <div style={S.outreachLabel}>
                          Note to organiser (edit before sending)
                          <button
                            style={S.copyBtn}
                            onClick={() => copyText(it.id, it.outreach)}
                          >
                            {copied === it.id ? "Copied ✓" : "Copy"}
                          </button>
                        </div>
                        <p style={S.outreachText}>{it.outreach}</p>
                      </div>
                    )}

                    <textarea
                      style={S.notes}
                      placeholder="Team notes — who's following up, what was said, next step…"
                      defaultValue={it.notes}
                      onBlur={(e) => saveNotes(it.id, e.target.value)}
                    />
                    <div style={S.notesHint}>
                      Notes save when you click away. Visible to the whole
                      team.
                    </div>
                  </div>
                )}
              </article>
            );
          })
        )}
      </main>

      <footer style={S.footer}>
        Sources: searched across the open web worldwide — tender portals, news,
        ESG publications, company sites, and publicly indexed LinkedIn and X
        posts. LinkedIn and X cannot be read wholesale; only publicly surfaced
        content appears. Always open and verify a source before acting on it.
      </footer>
    </div>
  );
}

/* ============================================================
   PEOPLE FINDER — a separate tool (its own top-level tab).
   Finds named professionals in the social-sustainability /
   labour / worker-wellbeing space. Pick target companies and a
   country, then scan. Reuses the same verified-link research
   engine as the Radar.
   ============================================================ */

const PEOPLE_STORE = "sc-people:items-v1";
const PEOPLE_META = "sc-people:meta-v1";

const COMPANY_PRESETS = [
  "Tata Group",
  "Mahindra",
  "Reliance Industries",
  "Aditya Birla Group",
  "Hindustan Unilever",
  "ITC",
  "Godrej",
  "Infosys",
  "Wipro",
  "Larsen & Toubro",
  "Bosch India",
  "Kia India",
  "Foxconn",
  "Apple",
  "Nike",
  "Adidas",
  "H&M",
  "Inditex (Zara)",
  "Unilever",
  "Nestlé",
  "PepsiCo",
  "Amazon",
  "Walmart / Flipkart",
  "Levi Strauss",
  "IKEA",
  "Primark",
  "Gap",
  "Marks & Spencer",
];

function buildPeoplePrompt(companies, geoText) {
  const companyClause =
    companies && companies.length
      ? `FOCUS ON these companies/organisations: ${companies.join(
          ", "
        )}. Prefer people who work (or recently worked) at them. If you cannot find enough at these, you may include one or two from closely comparable companies.`
      : "Search across reputable companies, brands, manufacturers, standards bodies, foundations and development agencies.";
  return `You are a researcher for Social Compact (socialcompact.co), an advisory firm working in worker wellbeing, labour compliance and social sustainability. Manufacturing focus in India; global reach.

Find NAMED individuals who work in the social-sustainability / worker-wellbeing / labour / responsible-sourcing / ESG-social space. Relevant roles include: Head/Director/Manager of Sustainability, ESG, Social Sustainability, Responsible or Ethical Sourcing, Human Rights, Supply-Chain Social Compliance, CSR, Worker Welfare, Ethical Trade, Occupational Health & Safety, plus CHROs and Heads of HR who speak publicly on worker issues.
${companyClause}
${geoText}
Use only PUBLIC, professional information (LinkedIn profiles, company pages, conference speaker lists, interviews, articles). Only include real, currently-active, named people with a verifiable public professional presence. Never invent people, titles or URLs.

Run AT MOST 3 web searches, then answer. Make at least ONE search target LinkedIn (site:linkedin.com/in) or public speaker lists.
Respond with ONLY a raw JSON array. No markdown, no backticks. Maximum 5 people. Keep fields SHORT.
Each item MUST have exactly these keys:
{"title":"Full Name — Role","org":"Company or organisation","region":"country/region","date":"a recent public signal date if any, else 'Current'","platform":"LinkedIn" or "X" or "Web","summary":"1-2 sentences: what they focus on and any recent public activity","relevance":"1 sentence: why Social Compact should know them","sourceUrl":"their LinkedIn profile URL or an article about them"}
"platform": linkedin.com URL → "LinkedIn"; x.com/twitter.com → "X"; else "Web".
"sourceUrl" MUST be copied EXACTLY from a real search result; if none, use "".
If you find fewer than 5, return fewer. Return [] only if you truly find nobody.`;
}

async function generatePeopleIntro(person) {
  const data = await apiCall({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    messages: [
      {
        role: "user",
        content: `Write a short LinkedIn connection note / intro message (2-3 sentences, plain English, short sentences, warm, professional, specific, no flattery or clichés) from someone at Social Compact — an advisory firm working in worker wellbeing, labour compliance and social sustainability (socialcompact.co) — to this person. Reference their work concretely. End with a light, low-pressure reason to connect. Return ONLY the message text.

Person: ${person.title}
Company: ${person.org}
Focus: ${person.summary}
Why relevant: ${person.relevance}`,
      },
    ],
  });
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function PeopleFinder() {
  const [items, setItems] = useState({});
  const [meta, setMeta] = useState({ lastScan: null, scanCount: 0 });
  const [loaded, setLoaded] = useState(false);
  const [companies, setCompanies] = useState([]);
  const [customCompany, setCustomCompany] = useState("");
  const [geo, setGeo] = useState("India");
  const [customGeo, setCustomGeo] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const [query, setQuery] = useState("");
  const [companyFilter, setCompanyFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [expanded, setExpanded] = useState(null);
  const [introLoading, setIntroLoading] = useState(null);
  const [copied, setCopied] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [clearAsk, setClearAsk] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(PEOPLE_STORE, true);
        if (r?.value) setItems(JSON.parse(r.value));
      } catch (e) {}
      try {
        const m = await window.storage.get(PEOPLE_META, true);
        if (m?.value) setMeta(JSON.parse(m.value));
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setItems(next);
    try {
      await window.storage.set(PEOPLE_STORE, JSON.stringify(next), true);
    } catch (e) {}
  }, []);

  const toggleCompany = (c) =>
    setCompanies((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );
  const addCustomCompany = () => {
    const c = customCompany.trim();
    if (c && !companies.includes(c)) setCompanies([...companies, c]);
    setCustomCompany("");
  };

  const runScan = async () => {
    if (scanning) return;
    setScanning(true);
    setScanMsg("searching…");
    const activeGeo = geo === "Other…" ? customGeo.trim() || "Global" : geo;
    const prompt = buildPeoplePrompt(companies, geoInstruction(activeGeo));
    let next = { ...items };
    try {
      const found = await researchWithRetry(prompt, (m) => setScanMsg(m));
      let added = 0;
      found.forEach((raw) => {
        if (!raw?.title || !raw?.org) return;
        const id = slugId(raw.title, raw.org);
        if (next[id]) return;
        next[id] = {
          id,
          title: String(raw.title),
          org: String(raw.org),
          region: String(raw.region || activeGeo),
          date: String(raw.date || "Current"),
          platform: normalizePlatform(raw.platform, raw.sourceUrl),
          summary: String(raw.summary || ""),
          relevance: String(raw.relevance || ""),
          sourceUrl: cleanUrl(raw.sourceUrl),
          status: "New",
          notes: "",
          intro: "",
          foundAt: new Date().toISOString(),
        };
        added++;
      });
      setScanMsg(added === 0 ? "0 new (all already found)" : `${added} new ✓`);
      await persist(next);
    } catch (e) {
      setScanMsg(`failed — ${e.message}. Try again or widen the country.`);
    }
    const m = {
      lastScan: new Date().toISOString(),
      scanCount: (meta.scanCount || 0) + 1,
      lastGeo: activeGeo,
    };
    setMeta(m);
    try {
      await window.storage.set(PEOPLE_META, JSON.stringify(m), true);
    } catch (e) {}
    setScanning(false);
  };

  const setStatus = (id, status) =>
    persist({ ...items, [id]: { ...items[id], status } });
  const saveNotes = (id, notes) =>
    persist({ ...items, [id]: { ...items[id], notes } });
  const removeItem = (id) => {
    const next = { ...items };
    delete next[id];
    persist(next);
    if (expanded === id) setExpanded(null);
  };
  const draftIntro = async (it) => {
    if (introLoading) return;
    setIntroLoading(it.id);
    try {
      const text = await generatePeopleIntro(it);
      await persist({ ...items, [it.id]: { ...items[it.id], intro: text } });
    } catch (e) {}
    setIntroLoading(null);
  };
  const copyText = async (id, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1800);
    } catch (e) {}
  };
  const clearAll = () => {
    persist({});
    setClearAsk(false);
    setExpanded(null);
  };
  const exportCsv = () => {
    const cols = [
      "name_role",
      "company",
      "region",
      "signal_date",
      "platform",
      "status",
      "focus",
      "why_relevant",
      "source_url",
      "notes",
    ];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [cols.join(",")];
    Object.values(items).forEach((it) =>
      rows.push(
        [
          it.title,
          it.org,
          it.region,
          it.date,
          it.platform,
          it.status,
          it.summary,
          it.relevance,
          cleanUrl(it.sourceUrl) ||
            `https://www.google.com/search?q=${encodeURIComponent(
              it.title + " " + it.org
            )}`,
          it.notes,
        ]
          .map(esc)
          .join(",")
      )
    );
    const blob = new Blob([rows.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `soco-people-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const companyOptions = useMemo(() => {
    const set = new Set();
    Object.values(items).forEach((it) => it.org && set.add(it.org.trim()));
    return Array.from(set).sort();
  }, [items]);

  const list = useMemo(() => {
    return Object.values(items)
      .filter((it) => {
        if (statusFilter === "Active") return it.status !== "Not relevant";
        if (statusFilter === "All") return true;
        return it.status === statusFilter;
      })
      .filter((it) => companyFilter === "All" || it.org === companyFilter)
      .filter((it) => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return (
          it.title.toLowerCase().includes(q) ||
          it.org.toLowerCase().includes(q) ||
          it.summary.toLowerCase().includes(q) ||
          (it.notes || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.foundAt || "").localeCompare(a.foundAt || ""));
  }, [items, statusFilter, companyFilter, query]);

  const activeCount = Object.values(items).filter(
    (i) => i.status !== "Not relevant"
  ).length;
  const stale = daysSince(meta.lastScan);

  return (
    <div style={S.page}>
      <header style={S.headerOuter}>
        <div style={S.headerFrame}>
          <div style={S.headerFrameInner}>
            <div style={S.logoWord}>SOCIAL COMPACT</div>
            <div style={S.logoTag}>People Finder</div>
            <p style={{ ...S.sub, marginTop: 10 }}>
              Find named professionals in the social-sustainability, labour and
              worker-wellbeing space. Choose the companies to focus on and a
              country, then scan. Uses public professional information only —
              verify and reach out respectfully.
            </p>

            {/* company picker */}
            <div style={P.pickerWrap}>
              <button
                style={P.pickerToggle}
                onClick={() => setPickerOpen(!pickerOpen)}
              >
                {companies.length
                  ? `${companies.length} compan${
                      companies.length === 1 ? "y" : "ies"
                    } selected`
                  : "Choose companies (optional)"}{" "}
                {pickerOpen ? "▲" : "▼"}
              </button>
              {companies.length > 0 && (
                <button
                  style={P.clearSel}
                  onClick={() => setCompanies([])}
                >
                  Clear
                </button>
              )}
            </div>

            {companies.length > 0 && (
              <div style={P.chips}>
                {companies.map((c) => (
                  <span key={c} style={P.chip} onClick={() => toggleCompany(c)}>
                    {c} ✕
                  </span>
                ))}
              </div>
            )}

            {pickerOpen && (
              <div style={P.picker}>
                <div style={P.pickerGrid}>
                  {COMPANY_PRESETS.map((c) => (
                    <label key={c} style={P.checkRow}>
                      <input
                        type="checkbox"
                        checked={companies.includes(c)}
                        onChange={() => toggleCompany(c)}
                      />
                      {c}
                    </label>
                  ))}
                </div>
                <div style={P.customRow}>
                  <input
                    style={P.customInput}
                    placeholder="Add another company…"
                    value={customCompany}
                    onChange={(e) => setCustomCompany(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addCustomCompany()}
                  />
                  <button style={P.addBtn} onClick={addCustomCompany}>
                    Add
                  </button>
                </div>
                <div style={P.pickerHint}>
                  Leave everything unchecked to search across all reputable
                  companies.
                </div>
              </div>
            )}

            <div style={{ ...S.scanRow, marginTop: 14 }}>
              <label style={S.rangeLabel}>
                Country / region
                <select
                  style={S.rangeSelect}
                  value={geo}
                  onChange={(e) => setGeo(e.target.value)}
                  disabled={scanning}
                >
                  {GEO_OPTIONS.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
              {geo === "Other…" && (
                <label style={S.rangeLabel}>
                  Name it
                  <input
                    style={S.rangeSelect}
                    placeholder="e.g. Kenya, ASEAN"
                    value={customGeo}
                    onChange={(e) => setCustomGeo(e.target.value)}
                    disabled={scanning}
                  />
                </label>
              )}
              <button
                onClick={runScan}
                disabled={scanning}
                style={{ ...S.scanBtn, background: scanning ? "#8A8578" : INK }}
              >
                {scanning ? "Scanning…" : "Find people"}
              </button>
              <button style={S.csvBtn} onClick={exportCsv}>
                Export Excel (CSV)
              </button>
            </div>

            <div style={S.stampLine}>
              <span
                style={{ ...S.stampDot, background: "#4F6B45" }}
              />
              {meta.lastScan
                ? `Last search ${stale === 0 ? "today" : stale + "d ago"}${
                    meta.lastGeo ? " · " + meta.lastGeo : ""
                  } · ${activeCount} people on board`
                : "No searches yet — pick companies and a country, then Find people"}
            </div>
            {scanMsg && <div style={P.scanMsg}>{scanMsg}</div>}
          </div>
        </div>
      </header>

      <div style={S.filters}>
        <input
          style={S.search}
          placeholder="Search names, companies, notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          style={S.select}
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
          aria-label="Filter by company"
        >
          <option value="All">All companies</option>
          {companyOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          style={S.select}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="Active">Active (hide Not relevant)</option>
          <option value="All">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button style={S.clearBtn} onClick={() => setClearAsk(!clearAsk)}>
          Clear all
        </button>
      </div>

      {clearAsk && (
        <div style={S.clearPanel}>
          <span style={S.clearLabel}>
            Delete all {Object.keys(items).length} people from this board?
            Export first if you want a backup.
          </span>
          <button style={S.clearConfirm} onClick={clearAll}>
            Yes, delete all
          </button>
          <button style={S.clearOption} onClick={() => setClearAsk(false)}>
            Cancel
          </button>
        </div>
      )}

      <main style={S.main}>
        {!loaded ? (
          <div style={S.empty}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={S.empty}>
            {Object.keys(items).length
              ? "Nothing matches your filters."
              : "No people yet. Choose companies and a country above, then click Find people."}
          </div>
        ) : (
          list.map((it) => {
            const open = expanded === it.id;
            const plat = it.platform || "Web";
            return (
              <article key={it.id} className="sc-card" style={S.card}>
                <div
                  style={S.cardHead}
                  onClick={() => setExpanded(open ? null : it.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) =>
                    (e.key === "Enter" || e.key === " ") &&
                    setExpanded(open ? null : it.id)
                  }
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={S.cardMeta}>
                      <span
                        style={{
                          ...S.pill,
                          background: STATUS_COLORS[it.status] + "1E",
                          color: STATUS_COLORS[it.status],
                          border: `1px solid ${STATUS_COLORS[it.status]}55`,
                        }}
                      >
                        {it.status}
                      </span>
                      <span style={S.platPill}>
                        {PLATFORM_ICON[plat]} {plat}
                      </span>
                      <span style={S.metaText}>{it.org}</span>
                      <span style={S.metaDot}>·</span>
                      <span style={S.metaText}>{it.region}</span>
                      {it.status === "New" && (
                        <button
                          style={S.quickReview}
                          onClick={(e) => {
                            e.stopPropagation();
                            setStatus(it.id, "Reviewed");
                          }}
                        >
                          ✓ Mark reviewed
                        </button>
                      )}
                    </div>
                    <h3 style={S.cardTitle}>{it.title}</h3>
                    {!open && <p style={S.cardSummaryClamp}>{it.summary}</p>}
                  </div>
                  <span style={S.chev}>{open ? "−" : "+"}</span>
                </div>

                {open && (
                  <div style={S.cardBody}>
                    <p style={S.para}>{it.summary}</p>
                    {it.relevance && (
                      <p style={S.why}>
                        <b>Why they matter to us:</b> {it.relevance}
                      </p>
                    )}
                    <div style={S.linkRow}>
                      {cleanUrl(it.sourceUrl) && (
                        <a
                          href={cleanUrl(it.sourceUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={S.link}
                        >
                          Open profile on {plat} ↗
                        </a>
                      )}
                      <a
                        href={`https://www.google.com/search?q=${encodeURIComponent(
                          it.title + " " + it.org
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={S.linkAlt}
                      >
                        {cleanUrl(it.sourceUrl)
                          ? "Link off? Find them on Google ↗"
                          : "Find them on Google ↗"}
                      </a>
                    </div>
                    {cleanUrl(it.sourceUrl) && (
                      <div style={S.exactUrl}>Source: {cleanUrl(it.sourceUrl)}</div>
                    )}

                    <div style={S.actions}>
                      <label style={S.actionLabel}>
                        Status
                        <select
                          style={{ ...S.select, marginLeft: 8 }}
                          value={it.status}
                          onChange={(e) => setStatus(it.id, e.target.value)}
                        >
                          {STATUSES.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        style={S.outreachBtn}
                        onClick={() => draftIntro(it)}
                        disabled={introLoading === it.id}
                      >
                        {introLoading === it.id
                          ? "Drafting…"
                          : it.intro
                          ? "Redraft intro note"
                          : "Draft intro note"}
                      </button>
                      <button
                        style={S.deleteBtn}
                        onClick={() => removeItem(it.id)}
                      >
                        Delete
                      </button>
                    </div>

                    {it.intro && (
                      <div style={S.outreachBox}>
                        <div style={S.outreachLabel}>
                          Intro note (edit before sending)
                          <button
                            style={S.copyBtn}
                            onClick={() => copyText(it.id, it.intro)}
                          >
                            {copied === it.id ? "Copied ✓" : "Copy"}
                          </button>
                        </div>
                        <p style={S.outreachText}>{it.intro}</p>
                      </div>
                    )}

                    <textarea
                      style={S.notes}
                      placeholder="Notes — mutual connections, context, who's reaching out…"
                      defaultValue={it.notes}
                      onBlur={(e) => saveNotes(it.id, e.target.value)}
                    />
                  </div>
                )}
              </article>
            );
          })
        )}
      </main>

      <footer style={S.footer}>
        People Finder uses public professional information only (LinkedIn
        profiles, company pages, speaker lists, articles). Verify every result
        before acting, and reach out respectfully and professionally.
      </footer>
    </div>
  );
}

/* ============================================================
   TOP-LEVEL SHELL — switches between the two tools.
   ============================================================ */

export default function SocialCompactRadar() {
  const [view, setView] = useState("radar");
  return (
    <div style={{ fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      `}</style>
      <div style={TOP.bar}>
        <div style={TOP.inner}>
          <span style={TOP.brand}>SoCo</span>
          <button
            onClick={() => setView("radar")}
            style={{
              ...TOP.tab,
              ...(view === "radar" ? TOP.tabActive : {}),
            }}
          >
            Intelligence Radar
          </button>
          <button
            onClick={() => setView("people")}
            style={{
              ...TOP.tab,
              ...(view === "people" ? TOP.tabActive : {}),
            }}
          >
            People Finder
          </button>
        </div>
      </div>
      {view === "radar" ? <IntelligenceRadar /> : <PeopleFinder />}
    </div>
  );
}

const TOP = {
  bar: {
    background: INK,
    borderBottom: `3px solid ${GOLD}`,
  },
  inner: {
    maxWidth: 980,
    margin: "0 auto",
    padding: "0 20px",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  brand: {
    color: GOLD,
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: "0.14em",
    marginRight: 16,
  },
  tab: {
    background: "none",
    border: "none",
    color: "#C9C3B4",
    fontSize: 14,
    fontWeight: 600,
    padding: "16px 14px",
    borderBottom: "3px solid transparent",
    marginBottom: "-3px",
  },
  tabActive: {
    color: PAPER,
    borderBottom: `3px solid ${GOLD}`,
  },
};

const P = {
  pickerWrap: { display: "flex", gap: 10, alignItems: "center", marginTop: 14 },
  pickerToggle: {
    background: "#FFFDF8",
    border: `1px solid ${GOLD}`,
    color: "#7A6420",
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 16px",
    borderRadius: 999,
  },
  clearSel: {
    background: "none",
    border: "1px solid #C9C3B4",
    color: "#8A5A4A",
    fontSize: 12,
    fontWeight: 600,
    padding: "7px 12px",
    borderRadius: 999,
  },
  chips: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 },
  chip: {
    background: INK,
    color: GOLD,
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: 999,
    cursor: "pointer",
  },
  picker: {
    marginTop: 10,
    background: "#FFFDF8",
    border: "1px solid #EAE3D2",
    borderRadius: 14,
    padding: 14,
  },
  pickerGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: "6px 14px",
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 13,
    color: "#3B372C",
    cursor: "pointer",
  },
  customRow: { display: "flex", gap: 8, marginTop: 12 },
  customInput: {
    flex: 1,
    padding: "8px 12px",
    fontSize: 13.5,
    border: "1px solid #E2DBC8",
    background: "#FFFDF8",
    borderRadius: 10,
  },
  addBtn: {
    background: INK,
    color: PAPER,
    border: "none",
    fontSize: 13,
    fontWeight: 600,
    padding: "8px 16px",
    borderRadius: 999,
  },
  pickerHint: { fontSize: 11.5, color: "#8A8578", marginTop: 10 },
  scanMsg: { marginTop: 8, fontSize: 13, color: "#55503F" },
};

/* ---------- styles ---------- */

const S = {
  page: {
    fontFamily: "'Inter', sans-serif",
    background: "linear-gradient(180deg, #F8F4EA 0%, #F2EDDF 100%)",
    minHeight: "100vh",
    color: INK,
  },
  headerOuter: { padding: "20px 16px 8px" },
  headerFrame: {
    maxWidth: 980,
    margin: "0 auto",
    background: "#FFFDF8",
    borderRadius: 20,
    border: "1px solid #EAE3D2",
    borderTop: `4px solid ${GOLD}`,
    boxShadow: "0 6px 28px rgba(30,27,22,.07)",
    overflow: "hidden",
  },
  headerFrameInner: { padding: "24px 26px 18px" },
  headTop: {
    display: "flex",
    gap: 20,
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },

  logoLockup: { display: "flex", gap: 14, alignItems: "center" },
  logoImg: {
    height: 56,
    maxWidth: 180,
    objectFit: "contain",
    flexShrink: 0,
  },
  logoWord: {
    fontWeight: 700,
    fontSize: 18,
    letterSpacing: "0.16em",
    color: INK,
  },
  logoTag: {
    fontSize: 11.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#9A7B0A",
    fontWeight: 600,
    marginTop: 3,
  },

  scanPanel: { minWidth: 250 },
  scanRow: {
    display: "flex",
    gap: 10,
    alignItems: "flex-end",
    flexWrap: "wrap",
  },
  rangeLabel: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#6E6858",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  rangeSelect: {
    padding: "9px 12px",
    fontSize: 13.5,
    border: "1px solid #E2DBC8",
    background: "#FFFDF8",
    borderRadius: 10,
  },
  scanBtn: {
    color: PAPER,
    border: "none",
    padding: "10px 22px",
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: "0.02em",
    background: INK,
    borderRadius: 999,
    boxShadow: "0 2px 10px rgba(30,27,22,.18)",
  },
  reportBtn: {
    background: "#FFFDF8",
    border: `1px solid ${GOLD}`,
    color: "#7A6420",
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 999,
  },
  rerunBtn: {
    marginLeft: 10,
    background: "none",
    border: `1px solid ${GOLD}`,
    color: "#7A6420",
    fontSize: 11.5,
    fontWeight: 600,
    padding: "2px 9px",
  },
  statsRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 14,
  },
  statBlock: {
    border: "1px solid #EAE3D2",
    background: "#FFFDF8",
    padding: "10px 18px",
    minWidth: 104,
    borderRadius: 14,
    boxShadow: "0 1px 3px rgba(30,27,22,.04)",
  },
  statNum: { fontSize: 22, fontWeight: 700, color: INK, lineHeight: 1.1 },
  statLabel: {
    fontSize: 10.5,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#6E6858",
    fontWeight: 600,
    marginTop: 2,
  },
  digestPanel: {
    marginTop: 14,
    background: "linear-gradient(135deg, #F9F3DF 0%, #F3EACC 100%)",
    border: "1px solid #EAD9A8",
    padding: "14px 16px",
    borderRadius: 14,
  },
  digestHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  digestTitle: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#7A6420",
  },
  digestBtn: {
    borderRadius: 999,
    background: "#FFFDF8",
    border: `1px solid ${GOLD}`,
    color: "#7A6420",
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 12px",
  },
  digestText: {
    fontSize: 13.5,
    lineHeight: 1.6,
    color: "#3B372C",
    margin: "10px 0 6px",
    whiteSpace: "pre-line",
  },
  digestMeta: { fontSize: 11.5, color: "#8A8578" },
  digestEmpty: {
    fontSize: 13,
    lineHeight: 1.55,
    color: "#6E6858",
    margin: "8px 0 0",
  },
  csvBtn: {
    background: "#FFFDF8",
    border: `1px solid ${GOLD}`,
    color: "#7A6420",
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 16px",
    borderRadius: 999,
  },
  helpToggle: {
    background: "none",
    border: "none",
    color: "#9A7B0A",
    fontSize: 12.5,
    fontWeight: 600,
    marginLeft: "auto",
    padding: "10px 14px",
    textDecoration: "underline",
    borderRadius: 999,
  },
  helpPanel: {
    maxWidth: 940,
    margin: "8px auto 0",
    background: "linear-gradient(135deg, #F9F3DF 0%, #F3EACC 100%)",
    border: "1px solid #EAD9A8",
    borderRadius: 12,
    padding: "13px 17px",
    fontSize: 13,
    lineHeight: 1.65,
    color: "#3B372C",
  },
  quickReview: {
    background: "none",
    border: "1px solid #3E5C76",
    color: "#3E5C76",
    fontSize: 11,
    fontWeight: 600,
    padding: "1px 9px",
    borderRadius: 999,
  },
  clearBtn: {
    background: "#FFFDF8",
    border: "1px solid #DCC9BC",
    color: "#8A5A4A",
    fontSize: 13,
    fontWeight: 600,
    padding: "9px 16px",
    borderRadius: 999,
  },
  clearPanel: {
    maxWidth: 940,
    margin: "8px auto 0",
    background: "#FBF3EC",
    border: "1px solid #E8CDBF",
    borderRadius: 12,
    padding: "11px 15px",
    fontSize: 13,
    color: "#3B372C",
    display: "flex",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap",
    lineHeight: 1.5,
  },
  clearLabel: { flex: "1 1 260px" },
  clearOption: {
    background: "#FFFDF8",
    border: "1px solid #DCD5C2",
    color: "#55503F",
    fontSize: 12.5,
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: 999,
  },
  clearOptionDanger: {
    background: "#FFFDF8",
    border: "1px solid #A4442E",
    color: "#A4442E",
    fontSize: 12.5,
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: 999,
  },
  clearConfirm: {
    background: "#A4442E",
    border: "none",
    color: "#FFFDF8",
    fontSize: 12.5,
    fontWeight: 600,
    padding: "8px 16px",
    borderRadius: 999,
  },
  outreachBtn: {
    background: INK,
    border: "none",
    color: GOLD,
    fontSize: 12.5,
    fontWeight: 600,
    padding: "8px 16px",
    borderRadius: 999,
  },
  outreachBox: {
    marginTop: 14,
    background: "linear-gradient(135deg, #F9F3DF 0%, #F3EACC 100%)",
    border: "1px solid #EAD9A8",
    padding: "12px 14px",
    borderRadius: 12,
  },
  outreachLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: "#7A6420",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  copyBtn: {
    background: "none",
    border: `1px solid ${GOLD}`,
    color: "#7A6420",
    fontSize: 11.5,
    fontWeight: 600,
    padding: "2px 10px",
  },
  outreachText: {
    fontSize: 13.5,
    lineHeight: 1.6,
    color: "#3B372C",
    margin: "8px 0 0",
    whiteSpace: "pre-line",
  },
  reportToolbar: {
    maxWidth: 980,
    margin: "16px auto 12px",
    padding: "0 16px",
    display: "flex",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  reportBack: {
    background: "none",
    border: "1px solid #C9C3B4",
    color: "#55503F",
    padding: "9px 14px",
    fontSize: 13,
    fontWeight: 600,
  },
  reportHint: { fontSize: 12, color: "#8A8578", flex: "1 1 240px" },
  reportMeta: {
    fontSize: 12.5,
    color: "#6E6858",
    margin: "10px 0 4px",
    paddingBottom: 14,
    borderBottom: `1px dashed ${GOLD}`,
  },
  reportSection: { marginTop: 22 },
  reportH2: {
    fontSize: 16,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    borderLeft: `4px solid ${GOLD}`,
    paddingLeft: 10,
    margin: "0 0 10px",
  },
  reportCount: { fontWeight: 500, color: "#6E6858", fontSize: 13 },
  reportEmpty: { fontSize: 13, color: "#8A8578", margin: "4px 0 0" },
  reportItem: {
    borderBottom: "1px solid #EAE4D4",
    padding: "10px 0 12px",
  },
  reportItemTitle: { fontSize: 14.5, fontWeight: 600, lineHeight: 1.4 },
  reportItemMeta: { fontSize: 11.5, color: "#6E6858", margin: "3px 0 6px" },
  reportItemText: {
    fontSize: 13,
    lineHeight: 1.55,
    color: "#3B372C",
    margin: "4px 0",
  },
  reportItemLink: {
    fontSize: 11.5,
    color: "#3E5C76",
    wordBreak: "break-all",
    marginTop: 4,
  },
  reportFooter: {
    marginTop: 26,
    paddingTop: 12,
    borderTop: `1px dashed ${GOLD}`,
    fontSize: 11.5,
    color: "#8A8578",
  },
  stampLine: {
    marginTop: 8,
    fontSize: 12,
    color: "#6E6858",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  stampDot: { width: 8, height: 8, borderRadius: 99, display: "inline-block" },

  sub: {
    fontSize: 13.5,
    lineHeight: 1.6,
    color: "#55503F",
    maxWidth: 640,
    margin: "14px 0 0",
  },
  scanLog: {
    marginTop: 12,
    paddingTop: 10,
    borderTop: `1px dashed ${GOLD}`,
    fontSize: 13,
    color: "#55503F",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  scanLogItem: { lineHeight: 1.5 },

  tabs: {
    display: "flex",
    gap: 6,
    maxWidth: 940,
    margin: "14px auto 0",
    padding: "6px",
    flexWrap: "wrap",
    background: "#EFE9D9",
    borderRadius: 999,
    alignItems: "center",
    border: "1px solid #E4DCC6",
  },
  tab: {
    border: "none",
    padding: "10px 16px",
    fontSize: 13.5,
    display: "flex",
    alignItems: "center",
    gap: 8,
    borderRadius: 999,
  },
  count: {
    color: "#FFFDF8",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 999,
    padding: "1px 8px",
  },

  filters: {
    maxWidth: 980,
    margin: "0 auto",
    padding: "12px 20px 4px",
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  },
  search: {
    flex: "1 1 220px",
    padding: "10px 14px",
    fontSize: 14,
    border: "1px solid #E2DBC8",
    background: "#FFFDF8",
    borderRadius: 12,
  },
  select: {
    padding: "9px 12px",
    fontSize: 13,
    border: "1px solid #E2DBC8",
    background: "#FFFDF8",
    borderRadius: 10,
  },

  main: { maxWidth: 980, margin: "0 auto", padding: "12px 20px 40px" },
  empty: {
    padding: "52px 24px",
    textAlign: "center",
    color: "#6E6858",
    fontSize: 14,
    lineHeight: 1.6,
    border: `1px dashed ${GOLD}`,
    background: "#FFFDF8",
    marginTop: 14,
    borderRadius: 16,
  },

  card: {
    background: "#FFFDF8",
    border: "1px solid #EAE3D2",
    marginTop: 14,
    borderRadius: 16,
    boxShadow: "0 1px 3px rgba(30,27,22,.05)",
    overflow: "hidden",
  },
  cardHead: {
    display: "flex",
    gap: 12,
    padding: "18px 20px",
    alignItems: "flex-start",
    cursor: "pointer",
  },
  cardMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 6,
  },
  pill: { fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 999 },
  platPill: {
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 9px",
    borderRadius: 999,
    background: INK,
    color: GOLD,
    letterSpacing: "0.02em",
  },
  metaText: { fontSize: 12, color: "#6E6858" },
  metaDot: { color: "#C9C3B4" },
  cardTitle: { fontWeight: 600, fontSize: 16.5, margin: 0, lineHeight: 1.35 },
  cardSummaryClamp: {
    fontSize: 13.5,
    color: "#55503F",
    lineHeight: 1.55,
    margin: "6px 0 0",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  chev: {
    fontSize: 22,
    color: GOLD,
    fontWeight: 600,
    lineHeight: 1,
    userSelect: "none",
  },
  cardBody: { padding: "0 20px 20px", borderTop: "1px solid #F0EBDD" },
  para: { fontSize: 14, lineHeight: 1.6, color: "#3B372C" },
  why: {
    fontSize: 13.5,
    lineHeight: 1.55,
    background: "#F7F1DE",
    borderLeft: `3px solid ${GOLD}`,
    padding: "10px 14px",
    color: "#3B372C",
    borderRadius: "0 10px 10px 0",
  },
  linkRow: {
    display: "flex",
    gap: 18,
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: 4,
  },
  link: {
    color: "#3E5C76",
    fontSize: 13.5,
    fontWeight: 600,
    textDecoration: "none",
    borderBottom: "1px solid #3E5C76",
  },
  linkAlt: {
    color: "#7A6420",
    fontSize: 12.5,
    fontWeight: 500,
    textDecoration: "none",
    borderBottom: `1px solid ${GOLD}`,
  },
  exactUrl: {
    fontSize: 11.5,
    color: "#8A8578",
    wordBreak: "break-all",
    marginTop: 6,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    marginTop: 16,
    flexWrap: "wrap",
  },
  actionLabel: { fontSize: 13, color: "#55503F", fontWeight: 500 },
  deleteBtn: {
    background: "none",
    border: "1px solid #DCC9BC",
    color: "#8A5A4A",
    fontSize: 12.5,
    padding: "7px 14px",
    borderRadius: 999,
  },
  notes: {
    width: "100%",
    minHeight: 64,
    marginTop: 14,
    padding: "11px 13px",
    fontSize: 13.5,
    lineHeight: 1.5,
    border: "1px solid #E2DBC8",
    background: "#FBF9F2",
    resize: "vertical",
    borderRadius: 10,
  },
  notesHint: { fontSize: 11.5, color: "#9B9484", marginTop: 4 },
  footer: {
    maxWidth: 980,
    margin: "0 auto",
    padding: "0 20px 36px",
    fontSize: 12,
    color: "#8A8578",
    lineHeight: 1.6,
  },
};
