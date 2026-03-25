export type SearchInput = {
  query: string;
  language: string | null;
  minStars: number;
  since: string | null;
  license: string | null;
  sort: "stars" | "updated" | "forks";
  top: number;
  random: boolean;
};

export type ParsedIntent = {
  language: string | null;
  since: string | null;
  license: string | null;
  maturitySignals: string[];
  concepts: string[];
  purposeTerms: string[];
  boostTerms: string[];
  displayTerms: string[];
  normalizedQuery: string;
  confidence: number;
};

type IntentConcept = {
  name: string;
  display: string;
  patterns: RegExp[];
  boostTerms: string[];
};

export function shouldClarifyBeforeSearch(intent: ParsedIntent): boolean {
  const structureCount =
    (intent.language ? 1 : 0) +
    (intent.since ? 1 : 0) +
    (intent.license ? 1 : 0) +
    intent.maturitySignals.length +
    intent.displayTerms.length;

  return intent.confidence < 0.4 && structureCount < 2;
}

export function buildClarificationPrompt(intent: ParsedIntent): string {
  if (intent.displayTerms.length === 0 && intent.language === null) {
    return "I am not confident I understood the repo type you want. Name the product category, stack, or deployment style you care about most.";
  }

  if (intent.displayTerms.length === 0) {
    return "I need one more concrete signal before searching. Try naming the repo category, framework, or deployment style.";
  }

  return "I have a partial read on your request, but not enough to trust the results. Try adding the language, framework, or license you care about most.";
}

export function buildBroaderSearchQuery(intent: ParsedIntent): string | null {
  const conceptTerms = [...new Set(intent.concepts.flatMap((concept) => conceptBroadTerms(concept)))];
  const broaderTerms =
    conceptTerms.length > 0
      ? [...conceptTerms, ...intent.boostTerms.filter((term) => !["observability", "statuspage"].includes(term))]
      : [...intent.boostTerms, ...intent.purposeTerms.slice(0, 3)];

  const uniqueTerms = [...new Set(broaderTerms)].filter(Boolean);
  if (uniqueTerms.length === 0) return null;
  return uniqueTerms.join(" ");
}

export function buildRetrievalQueries(intent: ParsedIntent, baseQuery: string): string[] {
  const queries = new Set<string>();
  const normalizedBase = baseQuery.trim();
  if (normalizedBase) {
    queries.add(normalizedBase);
  }

  if (intent.normalizedQuery && intent.normalizedQuery !== normalizedBase) {
    queries.add(intent.normalizedQuery);
  }

  const broader = buildBroaderSearchQuery(intent);
  if (broader && broader !== normalizedBase) {
    queries.add(broader);
  }

  if (intent.concepts.length > 0) {
    const conceptOnly = [...new Set(intent.concepts.flatMap((concept) => conceptBroadTerms(concept)))]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (conceptOnly && conceptOnly !== normalizedBase) {
      queries.add(conceptOnly);
    }
  }

  if (intent.purposeTerms.length > 0) {
    const purposeFocused = intent.purposeTerms.slice(0, 4).join(" ").trim();
    if (purposeFocused && purposeFocused !== normalizedBase) {
      queries.add(purposeFocused);
    }
  }

  if (intent.boostTerms.length > 0 && intent.purposeTerms.length > 0) {
    const hybrid = [...new Set([...intent.purposeTerms.slice(0, 3), ...intent.boostTerms.slice(0, 4)])]
      .join(" ")
      .trim();
    if (hybrid && hybrid !== normalizedBase) {
      queries.add(hybrid);
    }
  }

  return [...queries].filter(Boolean).slice(0, 5);
}

const STOP_WORDS = new Set([
  "find",
  "top",
  "best",
  "repos",
  "repo",
  "repositories",
  "projects",
  "project",
  "for",
  "building",
  "build",
  "with",
  "using",
  "that",
  "a",
  "an",
  "the",
  "in",
  "to",
  "i",
  "want",
  "need",
  "looking",
  "look",
  "something",
  "tool",
  "tools",
  "app",
  "apps",
  "my",
  "me",
  "on",
  "of",
  "and",
  "or",
  "run",
  "running",
  "good",
  "great",
  "cool",
  "well",
]);

const PURPOSE_STOP_WORDS = new Set([
  ...STOP_WORDS,
  "python",
  "typescript",
  "javascript",
  "rust",
  "go",
  "java",
  "lightweight",
  "production",
  "ready",
  "documented",
  "documentation",
  "docs",
  "mit",
  "apache",
  "open",
  "source",
  "actively",
  "maintained",
  "updated",
  "recently",
  "opensource",
]);

const BOOSTABLE_TERMS = new Set([
  "ollama",
  "desktop-app",
  "electron",
  "gui",
  "realtime",
  "websocket",
  "rest-api",
  "api-framework",
  "http-client",
  "api-client",
  "self-hosted",
  "inference",
  "chat",
  "llm",
]);

const INTENT_CONCEPTS: IntentConcept[] = [
  {
    name: "local-ai",
    display: "local LLM chat / inference",
    patterns: [/\blocal(?:-|\s)?llm\b/, /\bollama\b/, /\binference\b/, /\bllm\b/, /\bchat\b/],
    boostTerms: ["ollama", "llm", "inference", "chat"],
  },
  {
    name: "desktop-app",
    display: "desktop app",
    patterns: [/\bdesktop(?:-|\s)?app\b/, /\bdesktop\b/, /\belectron\b/, /\bgui\b/],
    boostTerms: ["desktop-app", "electron", "gui"],
  },
  {
    name: "self-hosted",
    display: "self-hosted",
    patterns: [/\bself-hosted\b/, /\bself hosted\b/],
    boostTerms: ["self-hosted"],
  },
  {
    name: "rest-api",
    display: "REST API",
    patterns: [/\brest(?:-|\s)?api\b/, /\bapi-framework\b/, /\bapi server\b/],
    boostTerms: ["rest-api", "api-framework"],
  },
  {
    name: "http-client",
    display: "HTTP client",
    patterns: [/\bhttp(?:-|\s)?client\b/, /\bapi-client\b/],
    boostTerms: ["http-client", "api-client"],
  },
  {
    name: "realtime",
    display: "real-time / websocket",
    patterns: [/\brealtime\b/, /\breal(?:-|\s)?time\b/, /\bwebsocket\b/],
    boostTerms: ["realtime", "websocket"],
  },
  {
    name: "monitoring",
    display: "monitoring / observability",
    patterns: [/\bmonitoring\b/, /\bobservability\b/, /\buptime\b/, /\bstatus page\b/],
    boostTerms: ["monitoring", "observability", "uptime", "statuspage"],
  },
  {
    name: "developer-tooling",
    display: "developer tooling",
    patterns: [/\bdeveloper tooling\b/, /\bdevtool\b/, /\bcli\b/, /\bterminal\b/],
    boostTerms: ["cli", "terminal", "developer-tooling"],
  },
];

export function detectLanguage(input: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/\bpython\b/, "Python"],
    [/\btypescript\b|\btype script\b|\bts only\b/, "TypeScript"],
    [/\bjavascript\b|\bjs\b/, "JavaScript"],
    [/\brust\b/, "Rust"],
    [/\bgo\b|\bgolang\b/, "Go"],
    [/\bjava\b/, "Java"],
    [/\bc#\b|\bcsharp\b/, "C#"],
    [/\bphp\b/, "PHP"],
    [/\bruby\b/, "Ruby"],
    [/\bshell\b|\bbash\b/, "Shell"],
  ];

  for (const [pattern, language] of patterns) {
    if (pattern.test(input)) return language;
  }
  return null;
}

export function normalizeSearchQuery(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !STOP_WORDS.has(word));

  return cleaned.join(" ").trim();
}

export function parseIntent(userInput: string): ParsedIntent {
  const raw = userInput.toLowerCase();
  let expanded = raw;
  const replacements: Array<[RegExp, string]> = [
    [/\bi want\b/g, " "],
    [/\bi need\b/g, " "],
    [/\bi(?:'d| would) like\b/g, " "],
    [/\bi(?:'m| am) looking for\b/g, " "],
    [/\bon my laptop\b/g, " local desktop "],
    [/\bon desktop\b/g, " desktop "],
    [/\bopen source\b/g, " opensource "],
    [/\bwell documented\b|\bwell-documented\b|\bgood docs\b/g, " documented "],
    [/\bself hosted\b|\bself-hosted\b/g, " self-hosted "],
    [/\blocal llms?\b/g, " local-llm ollama llm inference chat "],
    [/\bllms?\b/g, " llm inference chat "],
    [/\brest apis?\b/g, " rest-api api-framework "],
    [/\bhttp client\b/g, " http-client api-client "],
    [/\breal time\b|\brealtime\b/g, " realtime websocket "],
    [/\bdesktop app\b|\bdesktop application\b/g, " desktop-app electron gui "],
  ];

  for (const [pattern, replacement] of replacements) {
    expanded = expanded.replace(pattern, replacement);
  }

  const language = detectLanguage(raw);
  const since = /\b(actively maintained|active maintenance|updated recently|recently updated|actively developed)\b/.test(
    raw
  )
    ? isoDateDaysAgo(90)
    : null;

  let license: string | null = null;
  if (/\bmit only\b|\bmit licensed\b|\bmit license\b/.test(raw)) {
    license = "mit";
  } else if (/\bapache\b/.test(raw)) {
    license = "apache-2.0";
  }

  const maturitySignals: string[] = [];
  if (/\blightweight\b/.test(raw)) maturitySignals.push("lightweight");
  if (/\bproduction[- ]ready\b/.test(raw)) maturitySignals.push("production-ready");
  if (/\bwell documented\b|\bwell-documented\b|\bgood docs\b/.test(raw)) {
    maturitySignals.push("well documented");
  }

  const matchedConcepts = INTENT_CONCEPTS.filter((concept) =>
    concept.patterns.some((pattern) => pattern.test(expanded))
  );
  const displayTerms = new Set<string>(matchedConcepts.map((concept) => concept.display));

  const purposeTerms = expanded
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .filter((word) => !PURPOSE_STOP_WORDS.has(word));

  const uniquePurposeTerms = [...new Set(purposeTerms)];
  const conceptBoostTerms = matchedConcepts.flatMap((concept) => concept.boostTerms);
  const boostTerms = [...new Set([...conceptBoostTerms, ...uniquePurposeTerms.filter((term) => BOOSTABLE_TERMS.has(term))])];

  const signalCount =
    (language ? 1 : 0) +
    (since ? 1 : 0) +
    (license ? 1 : 0) +
    maturitySignals.length +
    Math.min(3, uniquePurposeTerms.length) +
    Math.min(2, matchedConcepts.length);
  const confidence = Math.min(1, signalCount / 6);

  return {
    language,
    since,
    license,
    maturitySignals,
    concepts: matchedConcepts.map((concept) => concept.name),
    purposeTerms: uniquePurposeTerms,
    boostTerms,
    displayTerms: [...displayTerms],
    normalizedQuery: uniquePurposeTerms.join(" ").trim(),
    confidence,
  };
}

export function inferFilters(
  userInput: string,
  search: SearchInput
): {
  search: SearchInput;
  applied: string[];
  intent: ParsedIntent;
} {
  const input = userInput.toLowerCase();
  const applied: string[] = [];
  const next = { ...search };
  const intent = parseIntent(userInput);

  if (!next.language && intent.language) {
    next.language = intent.language;
    applied.push(`Language: ${intent.language}`);
  } else if (next.language) {
    applied.push(`Language: ${next.language}`);
  }

  if (!next.since && intent.since) {
    next.since = intent.since;
    applied.push("Activity: updated in the last 90 days");
  } else if (next.since) {
    applied.push(`Activity: pushed after ${next.since}`);
  }

  if (intent.maturitySignals.includes("lightweight")) {
    next.query = `${next.query} lightweight`.trim();
    applied.push("Size/Maturity: lightweight");
  }
  if (intent.maturitySignals.includes("production-ready")) {
    next.query = `${next.query} production-ready`.trim();
    if (next.minStars < 1000) next.minStars = 1000;
    applied.push("Size/Maturity: production-ready");
  }
  if (intent.maturitySignals.includes("well documented")) {
    next.query = `${next.query} documentation docs`.trim();
    applied.push("Size/Maturity: well documented");
  }

  if (!next.license && intent.license) {
    next.license = intent.license;
    applied.push(`License: ${intent.license === "mit" ? "MIT" : "Apache-2.0"}`);
  } else if (!next.license && /\bopen source\b/.test(input)) {
    applied.push("License: open source");
  }

  if (intent.boostTerms.length > 0) {
    next.query = `${next.query} ${intent.boostTerms.join(" ")}`.trim();
  } else if (intent.normalizedQuery) {
    next.query = intent.normalizedQuery;
  }

  if (intent.displayTerms.length > 0) {
    applied.push(`Purpose: ${intent.displayTerms.join(", ")}`);
  } else if (intent.purposeTerms.length > 0) {
    applied.push(`Purpose: ${intent.purposeTerms.join(" ")}`);
  }

  return { search: next, applied, intent };
}

export function renderAppliedFilters(applied: string[]): string {
  if (applied.length === 0) return "";
  return ["Applied filters:", ...applied.map((item) => `- ${item}`), ""].join("\n");
}

function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function conceptBroadTerms(concept: string): string[] {
  switch (concept) {
    case "local-ai":
      return ["ollama", "llm", "inference", "chat"];
    case "desktop-app":
      return ["desktop", "electron", "gui"];
    case "self-hosted":
      return ["self-hosted"];
    case "rest-api":
      return ["rest-api", "api-framework", "api"];
    case "http-client":
      return ["http-client", "api-client"];
    case "realtime":
      return ["realtime", "websocket"];
    case "monitoring":
      return ["monitoring", "uptime", "status", "page"];
    case "developer-tooling":
      return ["cli", "terminal", "developer-tooling"];
    default:
      return [];
  }
}
