import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The dashboard script talks to a live PostHog, so the only honest way to test it
 * is to be PostHog: stand up a stub API, run the real script against it, and assert
 * on the calls it made. This exists because a `?dashboards=842020` that should have
 * read `?dashboards=[842020]` reached a creator's repo and answered 500 there.
 */

const SCRIPT = resolve(process.cwd(), 'scripts/posthog-dashboard.mjs');
const INSIGHT_COUNT = 14;
const GRID_COLUMNS = 12;
const DASHBOARD_DETAIL = /\/dashboards\/(\d+)\/$/;
const execFileAsync = promisify(execFile);

type Call = { method: string; url: URL; body: Record<string, unknown> | undefined };
type Box = { x: number; y: number; w: number; h: number };
type PatchedTile = { id: number; layouts: { sm: Box; xs: Box } };

/** A stub PostHog. `dashboards` is what GET /dashboards/ answers with. */
const stubPostHog = async (
  dashboards: Array<Record<string, unknown>>,
  insights: Array<Record<string, unknown>>,
  opts: { rejectLayout?: boolean } = {},
) => {
  const calls: Call[] = [];
  let nextId = 900;

  // Insight name → tile id, so GET /dashboards/:id/ can answer with tiles to
  // arrange. Seeded with whatever is already on the dashboard, then grown as the
  // script creates the rest — the same way a real project fills up.
  let nextTileId = 500;
  const tiles = new Map<string, number>();
  for (const insight of insights) tiles.set(String(insight.name), nextTileId++);

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const url = new URL(req.url ?? '/', 'http://stub');
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method ?? '', url, body });

      // Mirror PostHog: `dashboards` is a JSON array. A bare number parses fine and
      // then explodes on iteration, which is exactly how it fails in production.
      const filter = url.searchParams.get('dashboards');
      if (filter !== null && !Array.isArray(JSON.parse(filter))) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server_error', detail: 'A server error occurred.' }));
        return;
      }

      // A PostHog that has moved the layout schema on under our feet.
      if (opts.rejectLayout && req.method === 'PATCH' && DASHBOARD_DETAIL.test(url.pathname)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'validation_error', detail: 'Unknown field: layouts' }));
        return;
      }

      const detail = url.pathname.match(DASHBOARD_DETAIL);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.pathname.endsWith('/dashboards/') && req.method === 'GET') {
        res.end(JSON.stringify({ results: dashboards }));
      } else if (url.pathname.endsWith('/insights/') && req.method === 'GET') {
        res.end(JSON.stringify({ results: insights }));
      } else if (detail && req.method === 'GET') {
        res.end(
          JSON.stringify({
            id: Number(detail[1]),
            tiles: [...tiles].map(([name, id]) => ({ id, insight: { id: id + 1000, name } })),
          }),
        );
      } else {
        if (url.pathname.endsWith('/insights/') && req.method === 'POST') {
          const name = (body as { name?: string } | undefined)?.name;
          if (name !== undefined) tiles.set(name, nextTileId++);
        }
        res.end(JSON.stringify({ id: nextId++ }));
      }
    });
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { server, calls, host: `http://127.0.0.1:${port}` };
};

const run = async (host: string): Promise<{ code: number; out: string }> => {
  const env = {
    ...process.env,
    POSTHOG_PERSONAL_API_KEY: 'phx_test',
    POSTHOG_PROJECT_ID: '4242',
    POSTHOG_HOST: host,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT], { env });
    return { code: 0, out: stdout + stderr };
  } catch (thrown) {
    const err = thrown as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
};

let open: Server | undefined;
afterEach(() => open?.close());

describe('posthog-dashboard script', () => {
  it('creates the dashboard and every insight on a fresh project', async () => {
    const stub = await stubPostHog([], []);
    open = stub.server;

    const { code, out } = await run(stub.host);

    expect(code, out).toBe(0);
    const created = stub.calls.filter((c) => c.method === 'POST');
    expect(created.filter((c) => c.url.pathname.endsWith('/dashboards/'))).toHaveLength(1);
    expect(created.filter((c) => c.url.pathname.endsWith('/insights/'))).toHaveLength(
      INSIGHT_COUNT,
    );
    // Nothing can be on a dashboard made a moment ago, so don't go looking.
    expect(
      stub.calls.some((c) => c.method === 'GET' && c.url.pathname.endsWith('/insights/')),
    ).toBe(false);
  });

  it("asks for a dashboard's insights with a JSON array, not a bare id", async () => {
    const stub = await stubPostHog(
      [{ id: 7, name: 'Chai Analytics ☕', tags: ['buy-me-a-chai'] }],
      [],
    );
    open = stub.server;

    const { code, out } = await run(stub.host);

    expect(code, out).toBe(0);
    const lookup = stub.calls.find(
      (c) => c.method === 'GET' && c.url.pathname.endsWith('/insights/'),
    );
    expect(lookup?.url.searchParams.get('dashboards')).toBe('[7]');
    expect(JSON.parse(lookup?.url.searchParams.get('dashboards') ?? 'null')).toEqual([7]);
  });

  it('updates an insight it already made instead of duplicating it', async () => {
    const stub = await stubPostHog(
      [{ id: 7, name: 'Chai Analytics ☕', tags: ['buy-me-a-chai'] }],
      [{ id: 31, name: 'Visitors (unique)' }],
    );
    open = stub.server;

    const { code, out } = await run(stub.host);

    expect(code, out).toBe(0);
    // The insight it already made is patched, not re-created; the dashboard is
    // patched last, and only to lay the tiles out.
    expect(stub.calls.filter((c) => c.method === 'PATCH').map((c) => c.url.pathname)).toEqual([
      '/api/projects/4242/insights/31/',
      '/api/projects/4242/dashboards/7/',
    ]);
    expect(stub.calls.filter((c) => c.method === 'POST')).toHaveLength(INSIGHT_COUNT - 1);
  });

  it('lays every tile out on the 12-column grid without overlaps', async () => {
    const stub = await stubPostHog([], []);
    open = stub.server;

    const { code, out } = await run(stub.host);

    expect(code, out).toBe(0);
    const patch = stub.calls.find(
      (c) => c.method === 'PATCH' && DASHBOARD_DETAIL.test(c.url.pathname),
    );
    const tiles = (patch?.body as { tiles?: PatchedTile[] } | undefined)?.tiles ?? [];
    expect(tiles).toHaveLength(INSIGHT_COUNT);

    // Desktop: every tile inside the grid, and no two tiles claiming a cell. A
    // layout typo is otherwise invisible until a creator opens the dashboard and
    // finds two charts stacked on top of each other.
    const claimed = new Set<string>();
    const collisions: string[] = [];
    const overflowing: Box[] = [];
    for (const { layouts } of tiles) {
      const { x, y, w, h } = layouts.sm;
      if (w < 1 || h < 1 || x < 0 || y < 0 || x + w > GRID_COLUMNS) overflowing.push(layouts.sm);
      for (let cx = x; cx < x + w; cx++) {
        for (let cy = y; cy < y + h; cy++) {
          const cell = `${cx},${cy}`;
          if (claimed.has(cell)) collisions.push(cell);
          claimed.add(cell);
        }
      }
    }
    expect(overflowing).toEqual([]);
    expect(collisions).toEqual([]);

    // Mobile is one column wide, so it must be a plain stack: same order, same
    // heights, gapless.
    let y = 0;
    for (const { layouts } of tiles) {
      expect(layouts.xs).toEqual({ x: 0, y, w: 1, h: layouts.sm.h });
      y += layouts.sm.h;
    }
  });

  it('still finishes green when PostHog rejects the layout', async () => {
    const stub = await stubPostHog([], [], { rejectLayout: true });
    open = stub.server;

    const { code, out } = await run(stub.host);

    // The charts are the point. A layout schema change must not undo a run that
    // already put all of them on the dashboard.
    expect(code, out).toBe(0);
    expect(out).toContain('Could not set the tile layout');
    expect(
      stub.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/insights/')),
    ).toHaveLength(INSIGHT_COUNT);
  });

  it('fails loudly when PostHog rejects a call', async () => {
    const stub = await stubPostHog([], []);
    open = stub.server;
    stub.server.removeAllListeners('request');
    stub.server.on('request', (_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Permission denied' }));
    });

    const { code, out } = await run(stub.host);

    expect(code).toBe(1);
    expect(out).toContain('403');
    expect(out).toContain('dashboard:write');
  });
});
