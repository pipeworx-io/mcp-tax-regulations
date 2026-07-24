interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Tax Regulations MCP — US Treasury / IRS regulations (26 CFR, "Treas. Reg.").
 *
 * Treasury Regulations (a.k.a. IRS regulations / federal tax regulations) ARE
 * US federal regulations codified in Title 26 of the CFR (Internal Revenue).
 * Agents search "IRS regulation on X", "Treas. Reg. 1.170A-1", "the federal
 * tax regulation for X" — never "eCFR title 26". This is a thin, keyless
 * wrapper over the official eCFR API (www.ecfr.gov/api), scoped to the whole
 * of Title 26: income tax regs (part 1, dotted sections like 1.61-1,
 * 1.170A-1, 1.501(c)(3)-1), procedure & administration (part 301), estate &
 * gift tax (parts 20 & 25), employment tax (part 31), excise (parts 40+).
 *
 * Tax citations are dotted: "1.170A-1" means part 1, section 170A-1. The part
 * is the number BEFORE the first dot.
 *
 * Tools:
 * - tax_regulation: full text of one Treasury/IRS regulation by citation
 * - tax_search:     keyword search across federal tax regulations (26 CFR)
 *
 * Self-contained: does NOT import the eCFR pack — calls the eCFR API directly.
 */


const BASE = 'https://www.ecfr.gov/api';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const TITLE = 26;
const CITE = '26 CFR';

// --- XML/entity helpers ------------------------------------------------------
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s: unknown): string {
  if (typeof s !== 'string') return '';
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function xmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<HEAD>[\s\S]*?<\/HEAD>/g, '')
      .replace(/<\/(P|FP|HEAD|DIV\d+)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// --- eCFR fetch with per-attempt timeout + 503 retry -------------------------
async function ecfrOnce(path: string, accept: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      headers: { Accept: accept, 'User-Agent': UA },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ecfrFetch(path: string, accept: string, retries = 3): Promise<Response> {
  let res: Response | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      res = await ecfrOnce(path, accept, 12000);
      if (res.status !== 503) return res;
    } catch {
      res = null; // aborted (timeout) or network error — retry
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  if (res) return res;
  throw new Error('eCFR temporarily unavailable (the eCFR text endpoint is timing out — retry in a few seconds).');
}

async function ecfrGet(path: string): Promise<Record<string, unknown>> {
  const res = await ecfrFetch(path, 'application/json');
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

// Current currency date for this title, with a 7-day-ago fallback.
async function currentDate(): Promise<string> {
  try {
    const data = await ecfrGet('/versioner/v1/titles.json');
    const titles = Array.isArray(data.titles) ? (data.titles as Array<Record<string, unknown>>) : [];
    const t = titles.find((x) => Number(x.number) === TITLE);
    if (t && typeof t.up_to_date_as_of === 'string' && t.up_to_date_as_of) return t.up_to_date_as_of;
  } catch {
    /* fall through to date fallback */
  }
  return new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
}

// --- citation parsing (tax-specific: dotted sections) ------------------------
// Treasury/IRS citations are dotted: "1.170A-1", "1.61-1", "1.501(c)(3)-1",
// "301.7701-1", "20.2031-1". The PART is the number before the FIRST dot; the
// section number can contain letters, parenthetical groups, and a trailing
// "-N". A trailing paragraph like "(a)" after the section number is stripped.
// Forgiving inputs: "1.170A-1", "26 CFR 1.61-1", "Treas. Reg. 1.501(c)(3)-1",
// "§1.170A-1(b)", "section 1.61-1", or a bare part "1".
function parseCitation(raw: string): { section: string | null; part: string | null } {
  let s = raw.trim();
  s = s.replace(/§+/g, ' ');
  s = s.replace(/\b(26\s*cfr|treas\.?\s*reg\.?|treasury\s*regulations?|cfr|sections?|sec\.?)\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // part.sectionbody — sectionbody = leading alnum + optional paren groups + optional -N.
  const m = s.match(/(\d+)\.([0-9A-Za-z]+(?:\([0-9A-Za-z]+\))*(?:-\d+)?)/);
  if (m) return { section: `${m[1]}.${m[2]}`, part: m[1] };
  const pm = s.match(/\b(\d+)\b/);
  if (pm) return { section: null, part: pm[1] };
  return { section: null, part: null };
}

// Best-effort subpart lookup for a section, via the eCFR search hierarchy.
async function lookupSubpart(section: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ query: section, per_page: '5', order: 'relevance' });
    params.append('hierarchy[title]', String(TITLE));
    const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
    const results = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
    for (const r of results) {
      const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
      if (h.section != null && String(h.section) === section && h.subpart != null) {
        return String(h.subpart);
      }
    }
  } catch {
    /* ignore — subpart is optional metadata */
  }
  return null;
}

// --- tools -------------------------------------------------------------------
const tools: McpToolExport['tools'] = [
  {
    name: 'tax_regulation',
    description:
      'Get the full text of one Treasury Regulation / IRS regulation — a US federal tax regulation codified in 26 CFR — by its citation. Returns the exact regulatory wording currently in force. Answers "what does Treas. Reg. 1.170A say", "what is the IRS regulation for X", "the Treasury Regulation on X", "read 26 CFR 1.61-1", "the income tax regulation for X". Forgiving citation input: "1.170A-1", "26 CFR 1.61-1", "Treas. Reg. 1.501(c)(3)-1", "§1.170A-1", even "1.170A-1(b)" (trailing paragraph stripped). Tax citations are dotted — the part is the number BEFORE the first dot: "1.170A-1" -> part 1, section 170A-1; "301.7701-1" -> part 301. Covers 26 CFR part 1 income tax regulations (gross income, deductions, credits, charitable contributions 1.170A, exempt organizations 1.501(c)(3)-1, depreciation, capital gains), part 301 procedure & administration, parts 20 & 25 estate & gift tax, part 31 employment tax — the whole of Title 26. Pass a whole part (e.g. "1") to get a (large) section list. Example: tax_regulation({ citation: "1.170A-1" }) -> charitable contribution deduction; tax_regulation({ citation: "Treas. Reg. 1.61-1" }) -> gross income defined. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        citation: {
          type: 'string',
          description:
            'Treasury/IRS regulation citation (dotted). A section: "1.170A-1", "26 CFR 1.61-1", "Treas. Reg. 1.501(c)(3)-1", "§1.170A-1(b)", "301.7701-1". Or a bare part: "1", "301".',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'tax_search',
    description:
      'Keyword search across federal tax regulations — US Treasury / IRS regulations in 26 CFR. Answers "what tax regulations cover X", "the IRS regulation / Treasury Regulation about X", "find the federal tax rule for X". Great for topics: charitable contribution deduction, gross income, business expense deduction, depreciation and MACRS, capital gains and losses, section 501(c)(3) exempt organizations, S corporations, partnerships, like-kind exchanges, employment tax, estate and gift tax, foreign tax credit, retirement plans. Returns matching Treasury Regulations with citation (26 CFR / Treas. Reg.), heading, excerpt, and source URL. Example: tax_search({ query: "charitable contribution deduction" }); tax_search({ query: "depreciation", limit: 15 }). Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Federal-tax-regulation topic or phrase, e.g. "charitable contribution deduction", "gross income", "depreciation", "exempt organizations", "capital gains".',
        },
        limit: { type: 'number', description: 'Max results to return, 1-20 (default 10).' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'tax_regulation':
        return getRegulation(args);
      case 'tax_search':
        return searchRegulations(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function getRegulation(args: Record<string, unknown>): Promise<unknown> {
  const raw = typeof args.citation === 'string' ? args.citation : '';
  if (!raw.trim()) return { error: 'provide a citation, e.g. "1.170A-1" or "Treas. Reg. 1.61-1"' };

  const { section, part } = parseCitation(raw);
  if (!part) {
    return {
      error: `Could not parse a tax-regulation citation from "${raw}". Use a dotted section like "1.170A-1" or "26 CFR 1.61-1", or a part like "1".`,
    };
  }

  const date = await currentDate();

  // ---- whole part requested: return its section list -----------------------
  if (!section) {
    const res = await ecfrFetch(
      `/versioner/v1/full/${date}/title-${TITLE}.xml?part=${encodeURIComponent(part)}`,
      'application/xml',
    );
    if (res.status === 404) return { error: `${CITE} part ${part} not found as of ${date}.`, part, date };
    if (res.status === 503) return { error: 'eCFR temporarily unavailable — retry in a few seconds.', part };
    if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const xml = await res.text();
    const blocks = xml.split(/<DIV8\b/).slice(1);
    const sections = blocks
      .map((b) => {
        const n = b.match(/\bN="([^"]+)"/)?.[1] ?? null;
        const head = b.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
        return { section: n, heading: head ? stripHtml(head[1]) : null };
      })
      .filter((s) => s.section);
    return {
      part,
      citation: `${CITE} Part ${part}`,
      date,
      source: 'eCFR / Treasury (IRS) 26 CFR',
      source_url: `https://www.ecfr.gov/current/title-${TITLE}/part-${part}`,
      section_count: sections.length,
      note: `This is a whole tax-regulation part (${sections.length} sections). Call tax_regulation with a specific citation (e.g. "${sections[0]?.section ?? part + '.1-1'}") to get full text.`,
      sections: sections.slice(0, 500),
    };
  }

  // ---- single section ------------------------------------------------------
  const res = await ecfrFetch(
    `/versioner/v1/full/${date}/title-${TITLE}.xml?part=${encodeURIComponent(part)}&section=${encodeURIComponent(section)}`,
    'application/xml',
  );
  if (res.status === 404 || res.status === 400) {
    return {
      error: `Treasury/IRS regulation ${CITE} ${section} not found as of ${date}. Check the citation, or use tax_search to find it.`,
      citation: `${CITE} ${section}`,
      part,
      date,
    };
  }
  if (res.status === 503) return { error: 'eCFR temporarily unavailable — retry in a few seconds.', citation: `${CITE} ${section}` };
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.text();
  // eCFR returns JSON {"error":"No matching content found."} for removed/absent sections
  if (body.trim().startsWith('{')) {
    return {
      error: `Treasury/IRS regulation ${CITE} ${section} not found as of ${date}. Check the citation, or use tax_search to find it.`,
      citation: `${CITE} ${section}`,
      part,
      date,
    };
  }
  const xml = body;

  const headMatch = xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
  const heading = headMatch ? stripHtml(headMatch[1]) : null;
  const full = xmlToText(xml);
  const CAP = 30000;
  const truncated = full.length > CAP;
  const subpart = await lookupSubpart(section);

  return {
    citation: `${CITE} ${section}`,
    treas_reg: `Treas. Reg. § ${section}`,
    part,
    subpart: subpart ?? null,
    heading,
    text: truncated ? full.slice(0, CAP) : full,
    truncated,
    date,
    source: 'eCFR / Treasury (IRS) 26 CFR',
    source_url: `https://www.ecfr.gov/current/title-${TITLE}/section-${section}`,
  };
}

async function searchRegulations(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'provide a query, e.g. "charitable contribution deduction" or "depreciation"' };

  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
  const params = new URLSearchParams({
    query,
    per_page: String(Math.min(limit, 20)),
    page: '1',
    order: 'relevance',
  });
  params.append('hierarchy[title]', String(TITLE));

  const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
  const meta = (data.meta as Record<string, unknown> | undefined) ?? {};
  const rawResults = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];

  const results = rawResults
    .map((r) => {
      const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
      const headings = (r.headings as Record<string, unknown> | undefined) ?? {};
      const hHeadings = (r.hierarchy_headings as Record<string, unknown> | undefined) ?? {};
      const part = h.part != null ? String(h.part) : null;
      const section = h.section != null ? String(h.section) : null;
      const subpart = h.subpart != null ? String(h.subpart) : null;
      const heading =
        (typeof headings.section === 'string' && stripHtml(headings.section)) ||
        (typeof hHeadings.section === 'string' && stripHtml(hHeadings.section)) ||
        null;
      let citation: string | null = null;
      let source_url: string | null = null;
      if (section) {
        citation = `${CITE} ${section}`;
        source_url = `https://www.ecfr.gov/current/title-${TITLE}/section-${section}`;
      } else if (part) {
        citation = `${CITE} Part ${part}`;
        source_url = `https://www.ecfr.gov/current/title-${TITLE}/part-${part}`;
      }
      return {
        part,
        subpart,
        section,
        citation,
        treas_reg: section ? `Treas. Reg. § ${section}` : null,
        heading,
        excerpt: stripHtml(r.full_text_excerpt ?? (r as Record<string, unknown>).excerpt).slice(0, 300),
        source_url,
      };
    })
    .filter((r) => r.section || r.part)
    .slice(0, limit);

  return {
    query,
    total_matches: meta.total_count ?? null,
    count: results.length,
    scope: 'Federal tax regulations — 26 CFR (Treasury / IRS)',
    source: 'eCFR / Treasury (IRS) 26 CFR',
    results,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
