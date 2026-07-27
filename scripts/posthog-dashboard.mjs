#!/usr/bin/env node
/**
 * buy-me-a-chai — PostHog dashboard setup
 *
 * Creates (or updates) the "Chai Analytics" dashboard in YOUR PostHog project.
 * Dependency-free. Read docs/ANALYTICS.md before running.
 *
 * Usage:
 *   POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=12345 \
 *   POSTHOG_HOST=https://eu.posthog.com node scripts/posthog-dashboard.mjs
 *
 * Requires a PERSONAL API key (phx_...) with dashboard:write + insight:write,
 * NOT the project capture key (phc_...). You may delete the key afterwards.
 *
 * Idempotency: dashboard + insights are tagged "buy-me-a-chai". Re-runs update
 * existing items by name instead of duplicating.
 *
 * NOTE for maintainers: insight payloads use PostHog's query schema
 * (TrendsQuery / FunnelsQuery). PostHog evolves this schema; if creation fails
 * with a validation error, diff against https://posthog.com/docs/api/insights
 * and the posthog/posthog schema.ts, then bump payloads here. The tile-layout
 * PATCH is best-effort for the same reason — see `arrangeTiles`.
 */

const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
const PROJECT = process.env.POSTHOG_PROJECT_ID;
const HOST = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
const TAG = 'buy-me-a-chai';
const DASHBOARD_NAME = 'Chai Analytics ☕';

if (!KEY || !PROJECT) {
  console.error(
    'Missing env vars.\n' +
      '  POSTHOG_PERSONAL_API_KEY  (phx_..., Settings → Personal API keys)\n' +
      '  POSTHOG_PROJECT_ID        (Settings → Project)\n' +
      '  POSTHOG_HOST              (optional, default https://eu.posthog.com; use https://us.posthog.com for US)'
  );
  process.exit(1);
}
if (KEY.startsWith('phc_')) {
  console.error(
    'That is a PROJECT capture key (phc_...). This script needs a PERSONAL API key (phx_...).\n' +
      'Create one at: ' + HOST + '/settings/user-api-keys (scopes: dashboard:write, insight:write)'
  );
  process.exit(1);
}
if (/\.i\.posthog\.com/.test(HOST)) {
  console.error(
    HOST + ' is an ingestion host. Use the app host instead, e.g. https://eu.posthog.com or https://us.posthog.com'
  );
  process.exit(1);
}

const api = async (method, path, body) => {
  const res = await fetch(`${HOST}/api/projects/${PROJECT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 500)}`);
  }
  return res.json();
};

// ---------- insight query builders (PostHog query schema) ----------

const trends = (series, extra = {}) => ({
  kind: 'InsightVizNode',
  source: {
    kind: 'TrendsQuery',
    series,
    interval: extra.interval || 'day',
    dateRange: { date_from: extra.dateFrom || '-30d' },
    trendsFilter: extra.trendsFilter || { display: 'ActionsLineGraph' },
    ...(extra.breakdownFilter ? { breakdownFilter: extra.breakdownFilter } : {}),
  },
});

const ev = (event, extra = {}) => ({
  kind: 'EventsNode',
  event,
  name: event,
  ...extra,
});

/** A tile's box on the 12-column desktop grid. See `arrangeTiles`. */
const at = (x, y, w, h) => ({ x, y, w, h });

/**
 * The tiles, in the order they read on the dashboard: left to right, top to bottom.
 * That order is also the mobile stacking order and the fallback order PostHog would
 * auto-place them in if `arrangeTiles` ever can't run, so keep it meaningful.
 *
 * Tiles 11–14 break down on properties this project never sends. `before_send`
 * filters by event *name*, so posthog-js's own automatic properties — `utm_*`,
 * `$referrer`, `$referring_domain`, `$device_type` — ride along on all three of our
 * events and are what these read. See docs/ANALYTICS.md.
 */
const INSIGHTS = [
  {
    name: 'Device mix',
    description: 'Mobile-heavy audience ⇒ prioritize the deeplink/copy flow when testing.',
    layout: at(0, 0, 4, 4),
    query: trends([ev('page_view', { math: 'total' })], {
      trendsFilter: { display: 'ActionsBarValue' },
      breakdownFilter: { breakdown: '$device_type', breakdown_type: 'event' },
    }),
  },
  {
    name: 'Page views',
    description: 'Total page loads incl. repeat visits, daily.',
    layout: at(4, 0, 4, 4),
    query: trends([ev('page_view', { math: 'total' })]),
  },
  {
    name: 'Visitors (unique)',
    description: 'Unique people who opened your page, daily.',
    layout: at(8, 0, 4, 4),
    query: trends([ev('page_view', { math: 'dau' })]),
  },
  {
    name: 'Preset vs custom amount',
    description: 'If custom dominates, your presets are priced wrong.',
    layout: at(0, 4, 3, 4),
    query: trends([ev('amount_selected', { math: 'total' })], {
      trendsFilter: { display: 'ActionsPie' },
      breakdownFilter: { breakdown: 'preset', breakdown_type: 'event' },
      dateFrom: '-90d',
    }),
  },
  {
    name: 'Pay clicks by method',
    description:
      'deeplink vs copy_vpa vs qr_download. High copy_vpa on mobile usually means GPay/PhonePe are blocking deeplinks for your donors (expected, see ADR-006).',
    layout: at(3, 4, 4, 4),
    query: trends([ev('pay_clicked', { math: 'total' })], {
      trendsFilter: { display: 'ActionsBar' },
      breakdownFilter: { breakdown: 'method', breakdown_type: 'event' },
    }),
  },
  {
    name: 'Popular amounts',
    description: 'Which amounts donors select. Use this to tune your chai.presets tiers.',
    layout: at(7, 4, 5, 4),
    query: trends([ev('amount_selected', { math: 'total' })], {
      trendsFilter: { display: 'ActionsBarValue' },
      breakdownFilter: { breakdown: 'amount', breakdown_type: 'event' },
      dateFrom: '-90d',
    }),
  },
  {
    name: 'Amount interest (₹) — NOT revenue',
    description:
      'Sum of amounts on pay clicks per week. This is interest/"amount impressions", not money received — reconcile with your actual UPI statement.',
    layout: at(0, 8, 5, 5),
    query: trends(
      [ev('pay_clicked', { math: 'sum', math_property: 'amount' })],
      { interval: 'week', dateFrom: '-90d' }
    ),
  },
  {
    name: 'Intent funnel: view → amount → pay click',
    description:
      'Where interest leaks. Final step is payment INTENT — UPI P2P has no confirmation, so completed payments are unknowable by design.',
    layout: at(5, 8, 7, 5),
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'FunnelsQuery',
        series: [ev('page_view'), ev('amount_selected'), ev('pay_clicked')],
        dateRange: { date_from: '-30d' },
        funnelsFilter: { funnelWindowInterval: 7, funnelWindowIntervalUnit: 'day' },
      },
    },
  },
  {
    name: 'Total amount interest (₹) — NOT revenue',
    description:
      'All-time sum of the amounts donors clicked pay on. The single most misreadable number here: it is interest, not income. A donor can click and never pay, and you would never know — check your bank statement before believing this.',
    layout: at(0, 13, 4, 4),
    query: trends([ev('pay_clicked', { math: 'sum', math_property: 'amount' })], {
      trendsFilter: { display: 'BoldNumber' },
      dateFrom: 'all',
    }),
  },
  {
    name: 'Amount interest (₹) by source',
    description:
      'Which channel brings the most intent, in rupees. Blank = an untagged link or direct traffic. Still not revenue.',
    layout: at(4, 13, 4, 4),
    query: trends([ev('pay_clicked', { math: 'sum', math_property: 'amount' })], {
      trendsFilter: { display: 'ActionsBarValue' },
      breakdownFilter: { breakdown: 'utm_source', breakdown_type: 'event' },
      dateFrom: '-90d',
    }),
  },
  {
    name: 'Traffic by source',
    description:
      'People per utm_source. Blank means the link carried no utm_source — tag the links you post (?utm_source=twitter) and this fills in.',
    layout: at(8, 13, 4, 4),
    query: trends([ev('page_view', { math: 'dau' })], {
      trendsFilter: { display: 'ActionsBarValue' },
      breakdownFilter: { breakdown: 'utm_source', breakdown_type: 'event' },
      dateFrom: '-90d',
    }),
  },
  {
    name: 'Top referrers',
    description:
      'Where people actually came from, tagged or not. $direct means typed, bookmarked, or an app that strips the referrer — most chat and social apps do.',
    layout: at(0, 17, 4, 4),
    query: trends([ev('page_view', { math: 'dau' })], {
      trendsFilter: { display: 'ActionsBarValue' },
      breakdownFilter: { breakdown: '$referring_domain', breakdown_type: 'event' },
      dateFrom: '-90d',
    }),
  },
  {
    name: 'Campaigns',
    description:
      'People per utm_campaign. Empty until you tag a link — worth doing when you want to tell one video, post or newsletter apart from the next.',
    layout: at(4, 17, 4, 4),
    query: trends([ev('page_view', { math: 'dau' })], {
      trendsFilter: { display: 'ActionsBarValue' },
      breakdownFilter: { breakdown: 'utm_campaign', breakdown_type: 'event' },
      dateFrom: '-90d',
    }),
  },
  {
    name: 'Referrals from other chai pages',
    description:
      'People who arrived with ?ref= / ?source= — the sanitised host that linked here. This is how the template\'s own branding link makes clone-driven traffic countable without a backend (ADR-027). Empty if nobody links to you that way.',
    layout: at(8, 17, 4, 4),
    query: trends([ev('page_view', { math: 'dau' })], {
      trendsFilter: { display: 'ActionsBarValue' },
      breakdownFilter: { breakdown: 'source', breakdown_type: 'event' },
      dateFrom: '-90d',
    }),
  },
];

/**
 * Puts every tile where `layout` says, so a fresh dashboard opens arranged rather
 * than as a two-per-row pile in creation order (PostHog's auto-placement).
 *
 * A dashboard's `tiles` field is read-only on the way *out*, but its PATCH handler
 * reads `tiles` off the raw request body and writes each entry's display fields —
 * `layouts` among them — onto the tile with that id. Ids it doesn't recognise are
 * skipped server-side rather than erroring, so a tile you deleted by hand can't
 * fail a run. Grid is 12 columns on `sm` (desktop) and 1 on `xs` (mobile).
 *
 * This is authoritative: re-running the script restores the shipped arrangement
 * over any tiles you dragged yourself.
 */
const arrangeTiles = async (dashboardId) => {
  const detail = await api('GET', `/dashboards/${dashboardId}/`);
  const tileIdByName = new Map();
  for (const tile of detail.tiles || []) {
    if (tile.insight && tile.insight.name) tileIdByName.set(tile.insight.name, tile.id);
  }

  // `xs` is one column wide, so mobile is just the tiles stacked in declaration
  // order — the same order they read left-to-right, top-to-bottom on desktop.
  let xsY = 0;
  const tiles = [];
  for (const spec of INSIGHTS) {
    const id = tileIdByName.get(spec.name);
    if (id === undefined) continue;
    const { x, y, w, h } = spec.layout;
    tiles.push({ id, layouts: { sm: { x, y, w, h }, xs: { x: 0, y: xsY, w: 1, h } } });
    xsY += h;
  }

  if (tiles.length > 0) await api('PATCH', `/dashboards/${dashboardId}/`, { tiles });
  return tiles.length;
};

// ---------- main ----------

const main = async () => {
  console.log(`→ PostHog ${HOST}, project ${PROJECT}`);

  // 1. Find or create the dashboard (idempotent via tag + name)
  const existing = await api('GET', `/dashboards/?limit=300`);
  let dashboard = (existing.results || []).find(
    (d) => !d.deleted && (d.name === DASHBOARD_NAME || (d.tags || []).includes(TAG))
  );
  const reusing = Boolean(dashboard);
  if (dashboard) {
    console.log(`✓ Dashboard exists (id ${dashboard.id}) — updating insights`);
  } else {
    dashboard = await api('POST', `/dashboards/`, {
      name: DASHBOARD_NAME,
      description:
        'buy-me-a-chai analytics. All metrics are payment INTENT, never confirmed payments (UPI P2P has no callback). Docs: github.com/shivams136/buy-me-a-chai',
      tags: [TAG],
      pinned: true,
    });
    console.log(`✓ Created dashboard (id ${dashboard.id})`);
  }

  // 2. Upsert insights onto the dashboard by name.
  // `dashboards` is a JSON-encoded ARRAY of ids. A bare `?dashboards=842020` is
  // still valid JSON — it parses to a number, which PostHog then tries to iterate,
  // so the API answers 500 rather than 400. A dashboard created a moment ago holds
  // nothing, so skip the lookup there and save a round trip.
  const byName = new Map();
  if (reusing) {
    const filter = encodeURIComponent(JSON.stringify([dashboard.id]));
    const current = await api('GET', `/insights/?limit=300&dashboards=${filter}`);
    for (const insight of current.results || []) byName.set(insight.name, insight);
  }

  for (const spec of INSIGHTS) {
    const payload = {
      name: spec.name,
      description: spec.description,
      query: spec.query,
      tags: [TAG],
      // Deprecated in PostHog's API in favour of `dashboard_tiles`, which is
      // read-only — so this stays the only way to attach an insight on write.
      dashboards: [dashboard.id],
      saved: true,
    };
    const found = byName.get(spec.name);
    if (found) {
      await api('PATCH', `/insights/${found.id}/`, payload);
      console.log(`  ↻ updated  ${spec.name}`);
    } else {
      await api('POST', `/insights/`, payload);
      console.log(`  + created  ${spec.name}`);
    }
  }

  // 3. Arrange the tiles. Best-effort on purpose: the charts are the point, and a
  // creator can always drag them. A layout schema change must not fail a run that
  // has already put every chart on the dashboard.
  try {
    console.log(`✓ Arranged ${await arrangeTiles(dashboard.id)} tiles`);
  } catch (err) {
    console.warn(`! Could not set the tile layout — ${err.message.split('\n')[0]}`);
    console.warn('  Every chart is on the dashboard; drag them into place yourself.');
  }

  console.log(`\n✓ Done: ${HOST}/project/${PROJECT}/dashboard/${dashboard.id}`);
  console.log(
    'Reminder: numbers show intent, not income — see docs/ANALYTICS.md. You can delete the personal API key now.'
  );
};

main().catch((err) => {
  console.error('\n✖ Failed:', err.message);
  console.error(
    '\nCommon causes:\n' +
      '  401/403 → key lacks dashboard:write / insight:write scopes, or wrong host region\n' +
      '  404     → wrong POSTHOG_PROJECT_ID\n' +
      '  400 schema error → PostHog query schema changed; see maintainer note at top of this file\n' +
      '  500     → not yours to fix: this script sent something PostHog choked on.\n' +
      '            Open an issue on the template repo with the failing call above'
  );
  process.exit(1);
});
