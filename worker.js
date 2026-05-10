/**
 * MasterJi Notifier — Cloudflare Worker + D1 (Discord Version)
 *
 * Required env bindings (wrangler.toml / dashboard):
 * DB                      → D1 database binding
 * MASTERJI_ACCESS_TOKEN   → initial access JWT
 * MASTERJI_REFRESH_TOKEN  → initial refresh token
 * MASTERJI_BATCH_ID       → batch ID to filter tasks
 * MASTERJI_API_BASE       → Supabase REST base URL
 * MASTERJI_AUTH_BASE      → (optional) Supabase Auth base URL
 * SUPABASE_ANON_KEY       → Supabase anon key
 * DISCORD_WEBHOOK_URL     → (optional) Discord webhook URL
 *
 * Routes:
 * GET /        → health check
 * GET /check   → fetch new tasks and send notifications
 */

// ── Token helpers ─────────────────────────────────────────────────────────────

const TOKEN_SKEW_MS = 60_000;

/** In-memory dedup for the refresh flow within a single Worker invocation. */
let refreshInFlight = null;

function toAuthBase(apiBase) {
  const url = new URL(apiBase);
  if (/\/rest\/v1\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/rest\/v1\/?$/, "/auth/v1");
  } else {
    url.pathname = url.pathname.replace(/\/$/, "") + "/auth/v1";
  }
  return url.toString().replace(/\/$/, "");
}

function getJwtExp(token) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1]));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function expToIso(token) {
  const exp = getJwtExp(token);
  if (!exp) return new Date(Date.now() + 60_000).toISOString();
  return new Date(exp * 1000).toISOString();
}

function isExpiringSoon(expiresAtIso) {
  return new Date(expiresAtIso).getTime() <= Date.now() + TOKEN_SKEW_MS;
}

// ── D1 token cache ────────────────────────────────────────────────────────────

/**
 * Returns the single token_cache row, seeding it from env vars on first run.
 */
async function getTokenRow(env) {
  const row = await env.DB
    .prepare("SELECT * FROM token_cache ORDER BY updated_at DESC LIMIT 1")
    .first();

  if (row) return row;

  // First boot — seed from env vars
  const expiresAt = expToIso(env.MASTERJI_ACCESS_TOKEN);
  await env.DB
    .prepare(
      "INSERT INTO token_cache (access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, datetime('now'))"
    )
    .bind(env.MASTERJI_ACCESS_TOKEN, env.MASTERJI_REFRESH_TOKEN, expiresAt)
    .run();

  return env.DB
    .prepare("SELECT * FROM token_cache ORDER BY updated_at DESC LIMIT 1")
    .first();
}

async function refreshAccessToken(env) {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const row = await getTokenRow(env);
    const authBase =
      env.MASTERJI_AUTH_BASE ?? toAuthBase(env.MASTERJI_API_BASE);

    const res = await fetch(`${authBase}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: row.refresh_token }),
    });

    if (!res.ok) {
      throw new Error(
        `Auth refresh failed ${res.status}: ${await res.text()}`
      );
    }

    const data = await res.json();
    if (!data.access_token) throw new Error("Auth refresh missing access_token");

    const newRefresh = data.refresh_token ?? row.refresh_token;
    const expiresAt  = expToIso(data.access_token);

    await env.DB
      .prepare(
        "UPDATE token_cache SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(data.access_token, newRefresh, expiresAt, row.id)
      .run();

    return data.access_token;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function getAccessToken(env) {
  const row = await getTokenRow(env);
  if (isExpiringSoon(row.expires_at)) return refreshAccessToken(env);
  return row.access_token;
}

// ── Supabase fetch ────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function apiHeaders(token, anonKey) {
  return {
    apikey:           anonKey,
    Authorization:    `Bearer ${token}`,
    Accept:           "application/json",
    "Accept-Profile": "public",
  };
}

async function fetchTasks(endpoint, select, env) {
  const params = new URLSearchParams({
    select,
    batchId:     `in.(${env.MASTERJI_BATCH_ID})`,
    endDateTime: `gt.${nowIso()}`,
    order:       "endDateTime.asc",
    limit:       "50",
  });

  const url = `${env.MASTERJI_API_BASE}/${endpoint}?${params}`;

  let token = await getAccessToken(env);
  let res   = await fetch(url, { headers: apiHeaders(token, env.SUPABASE_ANON_KEY) });

  if (res.status === 401) {
    token = await refreshAccessToken(env);
    res   = await fetch(url, { headers: apiHeaders(token, env.SUPABASE_ANON_KEY) });
  }

  if (!res.ok) {
    throw new Error(`${endpoint} fetch failed ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtDue(dtStr) {
  try {
    const dt  = new Date(dtStr);
    const ist = new Date(dt.getTime() + (5 * 60 + 30) * 60_000);
    return (
      ist.toLocaleString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: true,
        timeZone: "UTC",
      }) + " IST"
    );
  } catch {
    return dtStr;
  }
}

// ── Discord notification ──────────────────────────────────────────────────────

async function notify(title, body, env) {
  // Uses env var if set in Cloudflare, otherwise falls back to your provided URL
  const webhookUrl = env.DISCORD_WEBHOOK_URL ;

  const payload = {
    content: `🔔 **${title}**\n\n${body}  \n\n <@DISCORD_USER_ID>`
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.warn(`Discord webhook failed ${res.status}: ${text} for "${title}"`);
  }
}

// ── /check handler ────────────────────────────────────────────────────────────

async function handleCheck(env) {
  // Fetch all three task types in parallel
  const [assignments, blogs, projects] = await Promise.all([
    fetchTasks(
      "BatchAssignment",
      "id,endDateTime,assignment:Assignment(name,category:AssignmentCategory(name))",
      env
    ),
    fetchTasks(
      "BatchBlogTopic",
      "id,endDateTime,blogTopic:BlogTopic(title)",
      env
    ),
    fetchTasks(
      "BatchProjectTopic",
      "id,endDateTime,projectTopic:ProjectTopic(title)",
      env
    ),
  ]);

  // Load already-seen IDs from D1
  const { results: seenRows } = await env.DB
    .prepare("SELECT id FROM seen_task")
    .all();
  const seenIds = new Set(seenRows.map((r) => r.id));

  const toInsert   = [];  // rows for seen_task
  const notified   = [];  // summary for the JSON response

  // ── Assignments ─────────────────────────────────────────────────────────────
  for (const item of assignments) {
    const tid = `assignment:${item.id}`;
    if (seenIds.has(tid)) continue;

    const name     = item.assignment?.name ?? "New Assignment";
    const category = item.assignment?.category?.name ?? "";
    const due      = fmtDue(item.endDateTime);

    toInsert.push({ id: tid, type: "assignment", name, due });
    notified.push({ type: "assignment", name, due, category });
  }

  // ── Blogs ────────────────────────────────────────────────────────────────────
  for (const item of blogs) {
    const tid = `blog:${item.id}`;
    if (seenIds.has(tid)) continue;

    const name = item.blogTopic?.title ?? "New Blog";
    const due  = fmtDue(item.endDateTime);

    toInsert.push({ id: tid, type: "blog", name, due });
    notified.push({ type: "blog", name, due });
  }

  // ── Projects ─────────────────────────────────────────────────────────────────
  for (const item of projects) {
    const tid = `project:${item.id}`;
    if (seenIds.has(tid)) continue;

    const name = item.projectTopic?.title ?? "New Project";
    const due  = fmtDue(item.endDateTime);

    toInsert.push({ id: tid, type: "project", name, due });
    notified.push({ type: "project", name, due });
  }

  if (toInsert.length > 0) {
    // Save to DB first
    const insertStmts = toInsert.map(({ id, type, name, due }) =>
      env.DB
        .prepare("INSERT OR IGNORE INTO seen_task (id, type, name, due) VALUES (?, ?, ?, ?)")
        .bind(id, type, name, due)
    );
    await env.DB.batch(insertStmts);

    // Build a single combined notification body
    const icon = { assignment: "📝", blog: "✍️", project: "🚀" };
    const lines = notified.map(({ type, name, due, category }) => {
      const prefix = category ? `[${category}] ` : "";
      return `${icon[type]} ${prefix}${name}\n   Due: ${due}`;
    });

    const title = `${notified.length} new task${notified.length > 1 ? "s" : ""} on MasterJi`;
    const body  = lines.join("\n\n");

    // Pass 'env' to the updated notify function
    await notify(title, body, env);
  }

  return Response.json({
    checked_at:    new Date().toISOString(),
    new_tasks:     notified.length,
    notified,
    total_tracked: seenIds.size + toInsert.length,
  });
}

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({ service: "MasterJi Notifier", status: "ok" });
    }

    if (url.pathname === "/check") {
      try {
        return await handleCheck(env);
      } catch (err) {
        console.error(err);
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};