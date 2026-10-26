// Prompt Review UI — vanilla JS, no deps. Stateful, checkpointed.
// Flow: load /api/data + /api/state → render row → user edits notes →
// debounced POST /api/state → "save & next" advances index and marks complete.

const $ = (id) => document.getElementById(id);

const els = {
  progress: $("progress"),
  status: $("status"),
  prevBtn: $("prev-btn"),
  nextBtn: $("next-btn"),
  saveNextBtn: $("save-next-btn"),
  filter: $("filter"),
  list: $("prompt-list"),
  rowId: $("row-id"),
  rowSummary: $("row-summary"),
  rowPath: $("row-path"),
  cols: {
    current:  { body: $("col-current"),  sub: $("col-current-sub"),  weak: null },
    new:      { body: $("col-new"),      sub: $("col-new-sub"),      weak: null,
                edited: $("col-new-edited"), revert: $("col-new-revert") },
    before:   { body: $("col-before"),   sub: $("col-before-sub"),   weak: null },
    claude:   { body: $("col-claude"),   sub: $("col-claude-sub"),   weak: $("col-claude-weak") },
    openclaw: { body: $("col-openclaw"), sub: $("col-openclaw-sub"), weak: $("col-openclaw-weak") },
    hermes:   { body: $("col-hermes"),   sub: $("col-hermes-sub"),   weak: $("col-hermes-weak") },
    codex:    { body: $("col-codex"),    sub: $("col-codex-sub"),    weak: $("col-codex-weak") },
    prime:    { body: $("col-prime"),    sub: $("col-prime-sub"),    weak: $("col-prime-weak") },
    kimi:     { body: $("col-kimi"),     sub: $("col-kimi-sub"),     weak: $("col-kimi-weak") },
  },
};

// Map column keys → their <article class="col col-{key}"> element for hide/show.
const colArticles = {};

let DATA = null;          // {rows, history_before, weak_threshold, total}
let STATE = { current_index: 0, reviewed: {} };
let saveTimer = null;
let lastSaved = "";       // last POSTed payload (for dirty/saved detection)
let showEmptyCols = false; // when false, reference columns w/ no entry are hidden

function migratePhasePromptState(reviewed) {
  const buildState = reviewed.build_system_prompt;
  const text = buildState && typeof buildState.edited_text === "string"
    ? buildState.edited_text
    : "";
  const boundary = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
  if (!text.includes(boundary) || !text.includes("# Current Phase")) return reviewed;

  const [before, after = ""] = text.split(boundary);
  reviewed.build_system_prompt = {
    ...buildState,
    edited_text: `${before.trimEnd()}\n\n${boundary}`,
  };

  let phaseText = after.split("# Current Phase", 2)[1] || "";
  phaseText = phaseText.split("# Tool Guidance", 1)[0].trim();
  if (phaseText.startsWith("PLAN -") && !reviewed.PLAN_PHASE_PROMPT) {
    reviewed.PLAN_PHASE_PROMPT = { edited_text: phaseText };
  } else if (phaseText.startsWith("EXECUTE -") && !reviewed.EXECUTE_PHASE_PROMPT) {
    reviewed.EXECUTE_PHASE_PROMPT = { edited_text: phaseText };
  }
  return reviewed;
}

function normalizeState(value) {
  const state = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const currentIndex = Number.isInteger(state.current_index) && state.current_index >= 0
    ? state.current_index
    : 0;
  const reviewedSource = state.reviewed &&
    typeof state.reviewed === "object" &&
    !Array.isArray(state.reviewed)
    ? state.reviewed
    : {};
  const reviewed = {};
  for (const [rowId, rowState] of Object.entries(reviewedSource)) {
    if (rowState && typeof rowState === "object" && !Array.isArray(rowState)) {
      reviewed[rowId] = { ...rowState };
    }
  }
  migratePhasePromptState(reviewed);
  return { current_index: currentIndex, reviewed };
}

// --- markdown renderer (just enough) ---------------------------------------
// Handles: code fences, inline code, headers (#…), bold **, italic *.
// Keeps line breaks. Escapes HTML first.
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function renderMd(src) {
  if (!src) return "";
  const text = String(src);
  const out = [];
  const lines = text.split("\n");
  let inFence = false;
  let fenceLang = "";
  let fenceBuf = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^```\s*([a-zA-Z0-9_-]*)\s*$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1];
        fenceBuf = [];
      } else {
        out.push(
          `<pre class="fence"><code data-lang="${escapeHtml(fenceLang)}">${escapeHtml(fenceBuf.join("\n"))}</code></pre>`
        );
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    let html = escapeHtml(line);
    // headers
    const h = html.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${h[2]}</h${lvl}>`);
      continue;
    }
    // inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
    // bold + italic (bold first to avoid clash)
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out.push(html);
  }
  if (inFence) {
    out.push(`<pre class="fence"><code>${escapeHtml(fenceBuf.join("\n"))}</code></pre>`);
  }
  return out.join("\n");
}

// --- prompt normalization ---------------------------------------------------
function tryParseJsonObject(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Some rendered schema files have literal newlines inside quoted strings.
    // Try a loose recovery pass by escaping in-string newlines, then re-parse.
    let recovered = "";
    let inStr = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (escape) {
        recovered += ch;
        escape = false;
        continue;
      }
      if (ch === "\\") {
        recovered += ch;
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inStr = !inStr;
        recovered += ch;
        continue;
      }
      if (inStr && ch === "\n") {
        recovered += "\\n";
        continue;
      }
      if (inStr && ch === "\r") {
        recovered += "\\r";
        continue;
      }
      recovered += ch;
    }
    try {
      const parsed = JSON.parse(recovered);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function schemaType(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.enum) && schema.enum.length) return "enum";
  if (schema.properties && typeof schema.properties === "object") return "object";
  if (schema.items) return "array";
  return "any";
}

function compactPromptText(value) {
  return String(value || "").replace(/\\n/g, "\n").replace(/\s+/g, " ").trim();
}

function collectSchemaArgs(schema, prefix = "") {
  if (!schema || typeof schema !== "object") return [];
  const props = schema.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out = [];

  for (const [name, def] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const item = def && typeof def === "object" ? def : {};
    out.push({
      name: path,
      required: required.has(name),
      type: schemaType(item),
      description: typeof item.description === "string" ? item.description.trim() : "",
      enumValues: Array.isArray(item.enum) ? item.enum : [],
      defaultValue: item.default,
      minimum: item.minimum,
      maximum: item.maximum,
    });

    if (item.properties && typeof item.properties === "object") {
      out.push(...collectSchemaArgs(item, path));
    } else if (item.items && typeof item.items === "object" && item.items.properties) {
      out.push(...collectSchemaArgs(item.items, `${path}[]`));
    }
  }
  return out;
}

function formatToolSchemaPrompt(obj) {
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null;
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const params = obj.parameters && typeof obj.parameters === "object" ? obj.parameters : null;
  const args = collectSchemaArgs(params || {});
  const requiredTop = params && Array.isArray(params.required) ? params.required : [];

  const lines = [];
  lines.push("## Tool Prompt");
  lines.push("");
  if (name) {
    lines.push("### Name");
    lines.push(`\`${name}\``);
    lines.push("");
  }

  lines.push("### Description");
  lines.push(description || "_No description provided._");
  lines.push("");
  lines.push("## Args");
  if (!args.length) {
    lines.push("_No arguments defined._");
    return lines.join("\n");
  }

  if (requiredTop.length) {
    lines.push(`Required: ${requiredTop.map((x) => `\`${x}\``).join(", ")}`);
    lines.push("");
  }

  for (const arg of args) {
    const constraints = [];
    if (arg.enumValues.length) {
      constraints.push(`allowed: ${arg.enumValues.map((v) => `\`${String(v)}\``).join(", ")}`);
    }
    if (arg.defaultValue !== undefined) constraints.push(`default: \`${String(arg.defaultValue)}\``);
    if (typeof arg.minimum === "number") constraints.push(`min: \`${arg.minimum}\``);
    if (typeof arg.maximum === "number") constraints.push(`max: \`${arg.maximum}\``);
    const suffix = constraints.length ? ` ${constraints.join("; ")}.` : "";
    const desc = compactPromptText(arg.description) || "No description provided.";
    lines.push(`- \`${arg.name}\` (\`${arg.type}\`, ${arg.required ? "required" : "optional"}): ${desc}${suffix}`);
  }
  return lines.join("\n").trim();
}

function isToolCategory(category) {
  return category === "tool_description" || category === "tool_param_description";
}

function inferToolArgsFromText(raw) {
  const args = new Map();
  const add = (name, contextLine) => {
    if (!name) return;
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) return;
    const key = name.toLowerCase();
    if (["use", "for", "with", "without", "only", "when", "type", "goal", "context", "args", "task", "tasks", "role"].includes(key)) {
      // keep high-signal common arg names explicitly whitelisted below
      if (!["type", "goal", "context", "tasks", "role"].includes(key)) return;
    }
    if (!args.has(name)) args.set(name, []);
    if (contextLine && args.get(name).length < 2) args.get(name).push(contextLine.trim());
  };

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const eqMatches = [...line.matchAll(/\b([a-z_][a-z0-9_]*)\s*=/gi)];
    for (const m of eqMatches) add(m[1], line);

    const quotedMatches = [...line.matchAll(/['"]([a-z_][a-z0-9_]*)['"]/gi)];
    for (const m of quotedMatches) {
      if (/(^|[^a-z_])(goal|context|toolsets|tasks|type|start_url|output_schema|github_repo_link|acp_command|acp_args|role|count|query|url|language|country|freshness|date_after|date_before|max_tokens|max_tokens_per_page)($|[^a-z_])/i.test(m[1])) {
        add(m[1], line);
      }
    }

    const mustMatch = line.match(/(?:^|-)\s*([a-z_][a-z0-9_]*)\s+must\b/i);
    if (mustMatch) add(mustMatch[1], line);

    const passMatch = line.match(/\bpass\s+([a-z_][a-z0-9_]*)\b/i);
    if (passMatch) add(passMatch[1], line);

    const knownArgs = [
      "type", "goal", "context", "tasks", "toolsets", "start_url",
      "output_schema", "github_repo_link", "role", "acp_command", "acp_args",
      "query", "url", "count", "country", "language", "freshness",
      "date_after", "date_before", "max_tokens", "max_tokens_per_page",
    ];
    for (const a of knownArgs) {
      if (new RegExp(`\\b${a}\\b`, "i").test(line)) add(a, line);
    }
  }

  return [...args.entries()].map(([name, clues]) => ({ name, clues }));
}

function formatPromptByType(text, category) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  if (isToolCategory(category)) {
    const parsed = tryParseJsonObject(raw);
    if (parsed && (parsed.parameters || parsed.description || parsed.name)) {
      return formatToolSchemaPrompt(parsed);
    }

    const parts = raw.split(/\n\s*\n/).filter((x) => x.trim().length);
    const desc = parts.length ? parts[0].trim() : raw;
    const rest = parts.slice(1).join("\n\n").trim();
    const inferredArgs = inferToolArgsFromText(raw);
    const lines = ["## Tool Prompt", "", "### Description", desc || "_No description provided._", "", "## Args"];
    if (!inferredArgs.length) {
      lines.push("_No explicit arguments described in this prompt text._");
    } else {
      for (const arg of inferredArgs) {
        const clue = compactPromptText(arg.clues.join(" "));
        lines.push(`- \`${arg.name}\` (\`unspecified\`, optional): ${clue || "Mentioned in prompt text."}`);
      }
    }
    if (rest) {
      lines.push("", "## Guidance", rest);
    }
    return lines.join("\n");
  }

  if (category === "system_prompt") return `## System Prompt\n\n${raw}`;
  if (category === "instruction_block") return `## Instruction Block\n\n${raw}`;
  if (category === "template") return `## Template\n\n${raw}`;
  return `## Prompt\n\n${raw}`;
}

// --- state -----------------------------------------------------------------
async function loadData() {
  const [data, state] = await Promise.all([
    fetch("/api/data").then((r) => r.json()),
    fetch("/api/state").then((r) => r.json()),
  ]);
  DATA = data;
  STATE = normalizeState(state);
  lastSaved = JSON.stringify(STATE);
  // Resolve <article> refs for each column key (used to hide empty columns).
  for (const key of Object.keys(els.cols)) {
    colArticles[key] = document.querySelector(`.col-${key}`);
  }
  // Default: collapse every agent section.
  for (const row of DATA.rows) {
    collapsedSections.add(row.agent || "shared");
  }
  renderList();
  renderCurrent();
  renderProgress();
  setStatus("loaded · ↑/↓ next · ⌘+Enter save&next", "saved");
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

function postStateNow() {
  STATE = normalizeState(STATE);
  return fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(STATE),
  })
    .then(async (r) => {
      const payload = await r.json();
      if (!r.ok || !payload.ok) throw new Error(payload.error || r.statusText);
      if (payload.state) STATE = normalizeState(payload.state);
      return payload;
    })
    .then(() => {
      lastSaved = JSON.stringify(STATE);
      setStatus("saved", "saved");
    })
    .catch((e) => {
      setStatus("save error: " + e, "error");
    });
}

function scheduleSave() {
  STATE = normalizeState(STATE);
  setStatus("unsaved…", "dirty");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(postStateNow, 500);
}

// --- render ----------------------------------------------------------------
function renderProgress() {
  const total = DATA.rows.length;
  const completed = Object.values(STATE.reviewed).filter(
    (r) => r && r.status === "completed"
  ).length;
  els.progress.textContent = `${completed} / ${total} reviewed · #${STATE.current_index + 1}`;
}

const AGENT_ORDER = [
  "main_shared",
  "main_plan",
  "main_execute",
  "planner",
  "verifier",
  "explore",
  "browser",
  "code",
  "sms",
  "voice",
  "chat",
  "shared",
];
const AGENT_LABELS = {
  main_shared: "Main Agent — Shared",
  main_plan: "Main Agent — PLAN",
  main_execute: "Main Agent — EXECUTE",
  planner: "Planner",
  verifier: "Verifier",
  explore: "Explore Sub-Agent",
  browser: "Browser Sub-Agent",
  code: "Code Sub-Agent",
  sms: "SMS Supervisor",
  voice: "Voice (VAPI)",
  chat: "Chat (backend)",
  shared: "Shared / Cross-cutting",
};
const CATEGORY_RANK = {
  system_prompt: 0,
  instruction_block: 1,
  template: 2,
  tool_description: 3,
  tool_param_description: 4,
};
const SUBGROUP_OF_CATEGORY = {
  system_prompt: "prompts",
  instruction_block: "prompts",
  template: "prompts",
  tool_description: "tools",
  tool_param_description: "tools",
};
const SUBGROUP_ORDER = ["prompts", "tools"];
const SUBGROUP_LABELS = {
  prompts: "System Prompts",
  tools: "Tools",
};
const collapsedSections = new Set();

function renderList() {
  const filter = (els.filter.value || "").trim().toLowerCase();
  els.list.innerHTML = "";

  // Two-level grouping: agent -> subgroup (prompts/tools) -> entries
  const groups = new Map();
  DATA.rows.forEach((row, i) => {
    const haystack = (row.id + " " + row.summary + " " + row.category + " " + (row.agent || "")).toLowerCase();
    if (filter && !haystack.includes(filter)) return;
    const agent = row.agent || "shared";
    const sub = SUBGROUP_OF_CATEGORY[row.category] || "prompts";
    if (!groups.has(agent)) groups.set(agent, new Map());
    const subgroups = groups.get(agent);
    if (!subgroups.has(sub)) subgroups.set(sub, []);
    subgroups.get(sub).push({ row, idx: i });
  });

  for (const subgroups of groups.values()) {
    for (const list of subgroups.values()) {
      list.sort((a, b) => {
        const ra = CATEGORY_RANK[a.row.category] ?? 99;
        const rb = CATEGORY_RANK[b.row.category] ?? 99;
        if (ra !== rb) return ra - rb;
        return a.row.id.localeCompare(b.row.id);
      });
    }
  }

  const orderedAgents = [
    ...AGENT_ORDER.filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((c) => !AGENT_ORDER.includes(c)),
  ];

  for (const agent of orderedAgents) {
    const subgroups = groups.get(agent);
    const label = AGENT_LABELS[agent] || agent.replace(/_/g, " ");

    let totalEntries = 0;
    let completedCount = 0;
    for (const list of subgroups.values()) {
      for (const { row } of list) {
        totalEntries++;
        const r = STATE.reviewed[row.id];
        if (r && r.status === "completed") completedCount++;
      }
    }

    const isCollapsed = collapsedSections.has(agent);

    const header = document.createElement("li");
    header.className = "section-header" + (isCollapsed ? " collapsed" : "");
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▾";
    const labelEl = document.createElement("span");
    labelEl.className = "section-label";
    labelEl.textContent = label;
    const countEl = document.createElement("span");
    countEl.className = "section-count";
    countEl.textContent = `${completedCount}/${totalEntries}`;
    header.appendChild(caret);
    header.appendChild(labelEl);
    header.appendChild(countEl);
    header.addEventListener("click", () => {
      if (collapsedSections.has(agent)) collapsedSections.delete(agent);
      else collapsedSections.add(agent);
      renderList();
    });
    els.list.appendChild(header);

    if (isCollapsed) continue;

    const orderedSubs = [
      ...SUBGROUP_ORDER.filter((s) => subgroups.has(s)),
      ...[...subgroups.keys()].filter((s) => !SUBGROUP_ORDER.includes(s)),
    ];

    for (const sub of orderedSubs) {
      const entries = subgroups.get(sub);
      const subLabel = SUBGROUP_LABELS[sub] || sub;
      const subCompleted = entries.filter(({ row }) => {
        const r = STATE.reviewed[row.id];
        return r && r.status === "completed";
      }).length;

      const subHeader = document.createElement("li");
      subHeader.className = "subsection-header";
      const subLabelEl = document.createElement("span");
      subLabelEl.className = "sub-label";
      subLabelEl.textContent = subLabel;
      const subCountEl = document.createElement("span");
      subCountEl.className = "sub-count";
      subCountEl.textContent = `${subCompleted}/${entries.length}`;
      subHeader.appendChild(subLabelEl);
      subHeader.appendChild(subCountEl);
      els.list.appendChild(subHeader);

      for (const { row, idx } of entries) {
        const reviewed = STATE.reviewed[row.id] || {};
        const li = document.createElement("li");
        li.dataset.idx = idx;
        const hasEdits = reviewed.edited_text && reviewed.edited_text.trim();
        li.className =
          "entry" +
          (idx === STATE.current_index ? " active" : "") +
          (reviewed.status === "completed" ? " completed" : "") +
          (hasEdits ? " has-notes" : "");
        const title = document.createElement("span");
        title.textContent = row.id;
        title.style.overflow = "hidden";
        title.style.textOverflow = "ellipsis";
        title.style.whiteSpace = "nowrap";
        title.style.flex = "1";
        li.appendChild(title);
        li.addEventListener("click", () => goTo(idx));
        els.list.appendChild(li);
      }
    }
  }
}

function setColEmpty(col, msg) {
  col.body.classList.add("empty");
  col.body.textContent = msg;
}
function setCol(col, text, category, formattedText = "") {
  col.body.classList.remove("empty");
  const display = (formattedText && String(formattedText).trim())
    ? String(formattedText)
    : formatPromptByType(text, category);
  col.body.innerHTML = renderMd(display);
}
function editableDefaultText(row) {
  const formatted = row && row.current ? String(row.current.formatted_text || "").trim() : "";
  if (row && isToolCategory(row.category) && formatted.includes("## Args")) {
    return formatted;
  }
  return (row && row.current ? row.current.text : "") || "";
}
function setColArticleHidden(key, hidden) {
  const article = colArticles[key];
  if (!article) return;
  article.classList.toggle("hidden", !!hidden);
}

function renderCurrent() {
  STATE = normalizeState(STATE);
  if (!DATA || !DATA.rows.length) return;
  const i = Math.max(0, Math.min(STATE.current_index, DATA.rows.length - 1));
  STATE.current_index = i;
  const row = DATA.rows[i];

  els.rowId.textContent = row.id;
  els.rowSummary.textContent = row.summary;
  const agentLabel = AGENT_LABELS[row.agent] || row.agent || "shared";
  els.rowPath.textContent = `${row.path} · ${row.category} · agent: ${agentLabel}`;

  // Helper: render a "rendered ✓" or "source ⚠" badge inline in a sub label.
  const sourceBadge = (s) => {
    if (s === "rendered") return ' <span class="src-tag src-rendered">runtime</span>';
    if (s === "source")  return ' <span class="src-tag src-source">source</span>';
    return ' <span class="src-tag src-missing">missing</span>';
  };

  // CURRENT
  els.cols.current.sub.innerHTML = `${escapeHtml(row.path)}${sourceBadge(row.current.source)}`;
  setCol(els.cols.current, row.current.text, row.category, row.current.formatted_text);

  // NEW (editable) — seed with prior edited_text, fall back to formatted tool
  // text so schema-derived Args are editable instead of hidden in comparison.
  const reviewedRow = STATE.reviewed[row.id] || {};
  const editedText = typeof reviewedRow.edited_text === "string" ? reviewedRow.edited_text : "";
  const defaultText = editableDefaultText(row);
  els.cols.new.body.value = editedText || defaultText;
  els.cols.new.sub.textContent = `editing ${row.id}`;
  const hasEdits = !!editedText.trim() && editedText !== defaultText;
  els.cols.new.edited.classList.toggle("show", hasEdits);
  els.cols.new.revert.classList.toggle("show", hasEdits);

  // BEFORE
  els.cols.before.sub.textContent = row.historical.label || "history";
  setCol(els.cols.before, row.historical.text, row.category, row.historical.formatted_text);

  // Match-source badge (explicit / auto / none).
  const matchBadge = (src) => {
    if (src === "explicit") return ' <span class="src-tag src-explicit" title="hand-picked semantic match (catalog.matches)">manual</span>';
    if (src === "auto") return ' <span class="src-tag src-auto" title="keyword-overlap auto-match (no manual mapping)">auto</span>';
    if (src === "explicit-broken") return ' <span class="src-tag src-missing" title="manual match points at non-existent id">broken</span>';
    if (src === "explicit-unset") return ' <span class="src-tag src-source" title="no manual mapping provided; intentionally not auto-matched">unmapped</span>';
    return "";
  };

  // CLAUDE / OPENCLAW / HERMES — hide entirely when there is no entry
  // (explicit "no equivalent" or no auto-match candidate). User can still see
  // them by toggling the show-empty switch in the topbar.
  for (const key of ["claude", "openclaw", "hermes", "codex", "prime", "kimi"]) {
    const r = row[key];
    if (!r || !r.entry) {
      if (!showEmptyCols) {
        setColArticleHidden(key, true);
        continue;
      }
      setColArticleHidden(key, false);
      const msg = r && r.match_source === "explicit-none"
        ? "no equivalent in this repo"
        : (r && r.match_source === "explicit-unset"
          ? "unmapped (manual pairing required)"
          : "no candidate found");
      setColEmpty(els.cols[key], msg);
      els.cols[key].sub.textContent =
        r && r.match_source === "explicit-none"
          ? "(intentionally none)"
          : (r && r.match_source === "explicit-unset" ? "(unmapped)" : "—");
      els.cols[key].weak.classList.remove("show");
      continue;
    }
    setColArticleHidden(key, false);
    const e = r.entry;
    const scoreLabel = r.match_source === "explicit"
      ? "manual match"
      : `score ${r.score.toFixed(2)}`;
    els.cols[key].sub.innerHTML =
      `${escapeHtml(e.id)} · ${escapeHtml(e.path)} (${scoreLabel})${matchBadge(r.match_source)}${sourceBadge(e.source)}`;
    setCol(els.cols[key], e.text, e.category, e.formatted_text);
    if (r.weak) els.cols[key].weak.classList.add("show");
    else els.cols[key].weak.classList.remove("show");
  }

  renderList();
  renderProgress();
  // Bring active item into view in the sidebar.
  const active = els.list.querySelector("li.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

// --- nav -------------------------------------------------------------------
function goTo(i) {
  if (i < 0 || i >= DATA.rows.length) return;
  STATE.current_index = i;
  renderCurrent();
  scheduleSave();
}
function next() { goTo(STATE.current_index + 1); }
function prev() { goTo(STATE.current_index - 1); }

function markCurrentComplete() {
  STATE = normalizeState(STATE);
  const row = DATA.rows[STATE.current_index];
  const prior = STATE.reviewed[row.id] || {};
  STATE.reviewed[row.id] = {
    ...prior,
    status: "completed",
    edited_text: els.cols.new.body.value || "",
    reviewed_at: new Date().toISOString(),
    ...(prior.first_seen ? { first_seen: prior.first_seen } : { first_seen: new Date().toISOString() }),
  };
}

function saveAndNext() {
  markCurrentComplete();
  // Find next un-reviewed prompt; fall back to plain next.
  const startedAt = STATE.current_index;
  let target = -1;
  for (let i = startedAt + 1; i < DATA.rows.length; i++) {
    const r = STATE.reviewed[DATA.rows[i].id];
    if (!r || r.status !== "completed") { target = i; break; }
  }
  if (target === -1) {
    for (let i = 0; i < startedAt; i++) {
      const r = STATE.reviewed[DATA.rows[i].id];
      if (!r || r.status !== "completed") { target = i; break; }
    }
  }
  if (target === -1) {
    setStatus("all reviewed!", "saved");
    renderList();
    renderProgress();
    postStateNow();
    return;
  }
  STATE.current_index = target;
  renderCurrent();
  postStateNow();
}

// --- events ----------------------------------------------------------------
els.prevBtn.addEventListener("click", prev);
els.nextBtn.addEventListener("click", next);
els.saveNextBtn.addEventListener("click", saveAndNext);
els.filter.addEventListener("input", renderList);
els.cols.new.body.addEventListener("input", () => {
  const row = DATA.rows[STATE.current_index];
  const prior = STATE.reviewed[row.id] || {};
  const text = els.cols.new.body.value;
  const defaultText = editableDefaultText(row);
  STATE.reviewed[row.id] = {
    ...prior,
    edited_text: text,
  };
  const hasEdits = !!text.trim() && text !== defaultText;
  els.cols.new.edited.classList.toggle("show", hasEdits);
  els.cols.new.revert.classList.toggle("show", hasEdits);
  renderList();
  scheduleSave();
});
els.cols.new.revert.addEventListener("click", () => {
  const row = DATA.rows[STATE.current_index];
  const prior = STATE.reviewed[row.id] || {};
  const next = { ...prior };
  delete next.edited_text;
  STATE.reviewed[row.id] = next;
  els.cols.new.body.value = editableDefaultText(row);
  els.cols.new.edited.classList.remove("show");
  els.cols.new.revert.classList.remove("show");
  renderList();
  scheduleSave();
});

const toggleEmptyBtn = $("toggle-empty-btn");
if (toggleEmptyBtn) {
  toggleEmptyBtn.addEventListener("click", () => {
    showEmptyCols = !showEmptyCols;
    toggleEmptyBtn.textContent = showEmptyCols ? "hide empty" : "show empty";
    renderCurrent();
  });
}

document.addEventListener("keydown", (e) => {
  // Avoid hijacking when typing in any textarea / search.
  const ae = document.activeElement;
  const inEditable =
    ae === els.filter ||
    (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT"));
  if (e.metaKey && e.key === "Enter") {
    e.preventDefault();
    saveAndNext();
    return;
  }
  if (inEditable) return;
  if (e.key === "ArrowRight" || e.key === "j") { e.preventDefault(); next(); }
  else if (e.key === "ArrowLeft" || e.key === "k") { e.preventDefault(); prev(); }
});

// Save on tab close (best effort).
window.addEventListener("beforeunload", () => {
  STATE = normalizeState(STATE);
  if (JSON.stringify(STATE) !== lastSaved) {
    navigator.sendBeacon &&
      navigator.sendBeacon("/api/state", new Blob([JSON.stringify(STATE)], { type: "application/json" }));
  }
});

// --- boot ------------------------------------------------------------------
loadData().catch((e) => setStatus("load error: " + e, "error"));
