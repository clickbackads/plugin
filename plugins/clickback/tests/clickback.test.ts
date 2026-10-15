import type { HttpResponse, On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import type { PendingLink } from '../hooks/clickback'
import { CONFIRM_TRIES, INTERVAL_MS, LAST_ASKED, LINK_POLLED, MAX_HREF, PENDING_LINK, POLL_SLACK_MS, TOKEN } from '../hooks/clickback'

tier('user')

const BASE = 'https://clickback.test'

const OPTIONS = { options: { base_url: BASE } }

const NOW = 1_800_000_000_000

/** The ad token a linked computer keeps in the store. */
const LINKED = { [TOKEN]: 'ad-token' }

const AD = {
  impression_id: 41,
  label: 'Sponsored',
  advertiser: 'Shipfast',
  headline: 'Deploy Laravel apps in 30 seconds',
  body: null,
  destination_host: 'shipfast.example.com',
  tracking_url: 'https://clickback.test/c/yQyJU8XBGHxG',
  shown_url: 'https://clickback.test/api/impressions/41/shown',
  text: 'Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → shipfast.example.com · https://clickback.test/c/yQyJU8XBGHxG',
  expires_at: '2026-10-05T12:00:00+00:00',
}

const SHOWN = '/api/impressions/41/shown'

/** What `POST /api/link` answers. */
const LINK = {
  device_code: 'device-1',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://clickback.test/link',
  verification_uri_complete: 'https://clickback.test/link?code=ABCD-EFGH',
  expires_in: 900,
  interval: 5,
}

/** A link another session started, as it keeps it in the store. */
const PENDING: PendingLink = {
  deviceCode: 'device-0',
  userCode: 'WXYZ-1234',
  uri: 'https://clickback.test/link',
  url: 'https://clickback.test/link?code=WXYZ-1234',
  expiresAt: NOW + 600_000,
  interval: 5,
}

/** What the band says while LINK waits for approval. */
const CONNECT_LINE = linked(
  'https://clickback.test/link?code=ABCD-EFGH',
  'Clickback · Connect this computer to start earning: https://clickback.test/link (code ABCD-EFGH)',
)

/** The whole ad line for AD, as the band draws it. */
const AD_LINE = linked('https://clickback.test/c/yQyJU8XBGHxG', 'Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → shipfast.example.com')

/** A band line as the drawing holds it: one Link to `href`, the whole text inside. */
function linked(href: string, text: string) {
  return [{ type: 'Link', props: { href }, children: [text] }]
}

/** A band line a surface won't open the address of: the same text, plain. */
function plain(text: string) {
  return [{ type: 'Text', children: [text] }]
}

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

/** A prompt the person typed and sent with Enter. */
const TYPED = { wait: false, origin: { kind: 'composer' } } as const

const ANSWERED = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as const

type Request = {
  method: string
  path: string
  headers: Record<string, string>
  body: Record<string, unknown> | undefined
}

/** How the server answers one path. An Error makes the request fail. */
type Route = (request: Request) => HttpResponse | Error | Promise<HttpResponse | Error>

type World = {
  /** Every request the mod made, in order. */
  requests: Request[]
  /** Every line the mod logged, and where it sent it. */
  logs: { text: string; to: string }[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

type Setup = {
  routes?: Record<string, Route>
  surfaces?: readonly RenderSurface[]
  store?: Record<string, unknown>
  now?: number
}

function json(status: number, data: unknown): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text: JSON.stringify(data) }
}

/** What `/api/ads/serve` answers with an ad, changed as given. */
function served(changes: Record<string, unknown> = {}): HttpResponse {
  return json(200, { ad: { ...AD, ...changes } })
}

/** Answers each request in turn, the last one from then on. */
function inTurn(...answers: HttpResponse[]): Route {
  let index = 0

  return () => answers[Math.min(index++, answers.length - 1)] as HttpResponse
}

/**
 * Everything beneath the mod: the session, the Clickback server, the store
 * every session shares, the clock, the band Claude Code leaves empty, and the
 * bottom of a turn and a prompt. Linked unless `store` says otherwise.
 */
function worldOf(on: On, setup: Setup = {}): World {
  const requests: Request[] = []
  const logs: World['logs'] = []
  const store = new Map<string, unknown>(Object.entries(setup.store ?? LINKED))
  const clock = mock.clock(on, { now: setup.now ?? NOW })
  const routes: Record<string, Route> = {
    '/api/link': () => json(201, LINK),
    '/api/link/token': () => json(202, { status: 'pending' }),
    '/api/ads/serve': () => served(),
    [SHOWN]: () => json(200, { shown: true, charged: true }),
    ...setup.routes,
  }

  on('session.surfaces', () => ({ value: setup.surfaces ?? ['terminal'] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('http.fetch', async ($, e) => {
    const url = new URL(e.url)
    const request = {
      method: e.init?.method ?? 'GET',
      path: url.origin === BASE ? url.pathname : e.url,
      headers: e.init?.headers ?? {},
      body: e.init?.body === undefined ? undefined : JSON.parse(e.init.body),
    }

    requests.push(request)

    const route = routes[request.path]
    const answer = route === undefined ? json(404, { message: 'Not found' }) : await route(request)

    return answer instanceof Error ? { deny: answer.message } : { value: answer }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push({ text: e.text, to: e.to })

    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

  return { requests, logs, store, clock }
}

/** The requests made to one path. */
function to(world: World, path: string): Request[] {
  return world.requests.filter(request => request.path === path)
}

function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal', props = BAND) {
  return $.ui.mount({ plugin: 'clickback', surface, component: 'AbovePrompt', props })
}

/** What the band's line holds, if the mod drew one: the first Text in the band. */
async function lineOf(ui: Awaited<ReturnType<typeof band>>) {
  return (await ui.find({ type: 'Text' }))?.children
}

/** The band is drawn, and the work the drawing started settles. */
async function draw($: Engine, world: World, surface: 'terminal' | 'desktop' = 'terminal', props = BAND) {
  const ui = await band($, surface, props)

  await world.clock.settle()

  return ui
}

/** A turn ends and the request it starts settles. */
async function turn($: Engine, world: World, turnId = 't1') {
  await $.turn.complete({ ...ANSWERED, turnId })
  await world.clock.settle()
}

describe('the ad', () => {
  test('after a turn the band shows one labelled line, the whole of it a link to the tracking URL', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await band($, surface)

      expect(await lineOf(ui)).toEqual(AD_LINE)
      expect((await ui.find({ type: 'Text' }))?.props).toEqual({ dimColor: true, wrap: 'wrap' })
      await ui.unmount()
    }
  })

  test('it asks over HTTP with the ad token, surface=mod, the app and the session id', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    expect(world.requests).toEqual([{
      method: 'POST',
      path: '/api/ads/serve',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ad-token' },
      body: { surface: 'mod', agent: 'claude-code', session_id: 'session-1' },
    }])
  })

  test('the next prompt takes the ad down and goes to Claude untouched', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    const ui = await band($)
    expect(await ui.find({ type: 'Link' })).toBeDefined()

    const entered = await $.prompt.submit({ ...TYPED, text: 'next thing' })

    expect(entered).toEqual({ text: 'next thing' })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
    await ui.unmount()
  })

  test('each ad is asked for once: another turn while it is still up asks for nothing', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)
    await world.clock.advance(INTERVAL_MS)
    await turn($, world, 't2')

    expect(to(world, '/api/ads/serve')).toHaveLength(1)
  })

  test('an ad that lands after the next prompt waits for that turn to end', OPTIONS, async ($, on) => {
    let answer: (response: HttpResponse) => void = () => {}
    const world = worldOf(on, { routes: { '/api/ads/serve': () => new Promise(resolve => (answer = resolve)) } })

    await turn($, world)
    await $.prompt.submit({ ...TYPED, text: 'quick follow-up' })
    answer(served())
    await world.clock.settle()

    const working = await band($, 'terminal', { ...BAND, isWorking: true })
    expect(await working.find({ type: 'Link' })).toBeUndefined()
    await working.unmount()

    await turn($, world, 't2')

    const idle = await band($)
    expect(await idle.find({ type: 'Link' })).toBeDefined()
    expect(to(world, '/api/ads/serve')).toHaveLength(1)
    await idle.unmount()

    await $.prompt.submit({ ...TYPED, text: 'and another' })

    const after = await band($)
    expect(await after.find({ type: 'Link' })).toBeUndefined()
    await after.unmount()
  })

  test('the desktop app gets the same line, reported as claude-code-desktop', OPTIONS, async ($, on) => {
    const world = worldOf(on, { surfaces: ['desktop'] })

    await turn($, world)

    const ui = await band($, 'desktop')
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://clickback.test/c/yQyJU8XBGHxG')
    expect(world.requests[0]?.body?.agent).toBe('claude-code-desktop')
    await ui.unmount()
  })

  test('claude -p and the SDK draw nowhere, so nothing is asked, linked or stamped', OPTIONS, async ($, on) => {
    const linked = worldOf(on, { surfaces: [] })

    await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
    await turn($, linked)

    expect(linked.requests).toEqual([])
    expect(linked.store.has(LAST_ASKED)).toBe(false)
  })

  test('without a token, claude -p links nothing either', OPTIONS, async ($, on) => {
    const world = worldOf(on, { surfaces: [], store: {} })

    await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
    await turn($, world)

    expect(world.requests).toEqual([])
  })

  test('a surface without the band (VS Code, mobile) is never asked for', OPTIONS, async ($, on) => {
    const world = worldOf(on, { surfaces: ['vscode', 'mobile'] })

    await turn($, world)

    expect(world.requests).toEqual([])
  })

  test('subagent turns, interrupts and errors ask for nothing', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete({ ...ANSWERED, agentId: 'agent-1' })
    await $.turn.complete({ ...ANSWERED, reason: 'aborted', isAborted: true })
    await $.turn.complete({ ...ANSWERED, reason: 'error' })
    await world.clock.settle()

    expect(world.requests).toEqual([])
  })

  for (const [name, response] of [
    ['nothing to show', json(200, { ad: null })],
    ['a server error', json(500, { message: 'Server Error' })],
    ['a 204', { status: 204, ok: true, headers: {}, text: '' }],
    ['text that is not JSON', { status: 200, ok: true, headers: {}, text: '<html>Down for maintenance</html>' }],
    ['an ad not under "ad"', json(200, AD)],
    ['an ad with no link', served({ tracking_url: 'javascript:alert(1)' })],
    ['an ad whose link is too long for a Link', served({ tracking_url: `https://clickback.test/c/${'a'.repeat(MAX_HREF)}` })],
    ['an ad whose link is too long once percent-encoded', served({ tracking_url: `https://clickback.test/c/${'é'.repeat(700)}` })],
    ['an ad with no headline', served({ headline: '' })],
    ['an ad with no impression id', served({ impression_id: null })],
    ['an ad with nowhere to confirm it', served({ shown_url: null })],
    ['an ad confirmed on another server', served({ shown_url: 'https://evil.example/api/impressions/41/shown' })],
  ] as const) {
    test(`${name} shows nothing`, OPTIONS, async ($, on) => {
      const world = worldOf(on, { routes: { '/api/ads/serve': () => response } })

      await turn($, world)

      const ui = await draw($, world)
      expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
      expect(to(world, SHOWN)).toEqual([])
      expect(world.requests.map(request => request.path)).toEqual(['/api/ads/serve'])
      await ui.unmount()
    })
  }

  test('a failed request shows nothing and leaves the turn alone', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => new Error('ECONNREFUSED') } })

    expect(await $.turn.complete(ANSWERED)).toEqual({ text: 'ok' })
    await world.clock.settle()

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a slow server is given up on after 3 seconds', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => world.clock.sleep(10_000).then(() => served()) } })

    await $.turn.complete(ANSWERED)
    await world.clock.advance(3_000)

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()

    await world.clock.advance(10_000)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the turn finishes before the server answers', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => world.clock.sleep(2_000).then(() => served()) } })
    const start = world.clock.now()

    expect(await $.turn.complete(ANSWERED)).toEqual({ text: 'ok' })
    expect(world.clock.now()).toBe(start)

    await world.clock.advance(2_000)

    const ui = await band($)
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  })

  test('a local http tracking link is still a Link; the Desktop app draws the line plain', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => served({ tracking_url: 'http://clickback.test/c/abc' }) } })
    const text = 'Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → shipfast.example.com'

    await turn($, world)

    // The terminal opens any scheme. The Desktop app only opens https (and
    // http://localhost): it draws the text plain and the band still stands.
    for (const [surface, line] of [
      ['terminal', linked('http://clickback.test/c/abc', text)],
      ['desktop', plain(text)],
    ] as const) {
      const ui = await band($, surface)

      expect(await lineOf(ui)).toEqual(line)
      await ui.unmount()
    }
  })

  test('a long ad wraps onto another row instead of being cut off', OPTIONS, async ($, on) => {
    const headline = 'Preview environments for every pull request, seeded databases, and a URL you can share with the whole team'
    const world = worldOf(on, { routes: { '/api/ads/serve': () => served({ headline }) } })

    await turn($, world)

    const ui = await band($, 'terminal', { ...BAND, bodyColumns: 60 })

    expect((await ui.find({ type: 'Text' }))?.props.wrap).toBe('wrap')
    expect(await lineOf(ui)).toEqual(linked(AD.tracking_url, `Sponsored · Shipfast: ${headline} → shipfast.example.com`))
    await ui.unmount()
  })

  test(`a tracking link of exactly ${MAX_HREF} characters is still drawn`, OPTIONS, async ($, on) => {
    const href = `https://clickback.test/c/${'a'.repeat(MAX_HREF - 'https://clickback.test/c/'.length)}`
    const world = worldOf(on, { routes: { '/api/ads/serve': () => served({ tracking_url: href }) } })

    await turn($, world)

    const ui = await band($)
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(href)
    await ui.unmount()
  })

  test('control characters and terminal escapes from the server are flattened', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      routes: { '/api/ads/serve': () => served({ advertiser: 'Ship\u001b]8;;https://evil.example\u0007fast', headline: 'Line one\nline two‮' }) },
    })

    await turn($, world)

    const ui = await band($)
    expect(await lineOf(ui)).toEqual(linked(AD.tracking_url, 'Sponsored · Ship ]8;;https://evil.example fast: Line one line two → shipfast.example.com'))
    expect((await ui.find({ type: 'Text' }))?.text).not.toMatch(/[\u0000-\u001f‮]/)
    await ui.unmount()
  })

  test('what other mods draw in the band stays under the ad', {
    ...OPTIONS,
    plugins: [{
      name: 'token-weather',
      tier: 'append',
      register(on) {
        on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'Clear skies' }))
      },
    }],
  }, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    const ui = await band($)
    expect(await lineOf(ui)).toEqual(AD_LINE)
    expect(await ui.find({ type: 'Text', text: 'Clear skies' })).toBeDefined()
    await ui.unmount()
  })

  test('the band yields to a survey, a running turn and an agent view', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    for (const props of [
      { ...BAND, hasSurvey: true },
      { ...BAND, isWorking: true },
      { ...BAND, view: { agentId: 'agent-1' } },
    ]) {
      const ui = await band($, 'terminal', props)
      expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
      await ui.unmount()
    }
  })
})

describe('once a minute', () => {
  test('it notes when it asked, in the store every session shares', OPTIONS, async ($, on) => {
    const world = worldOf(on, { now: NOW })

    await turn($, world)

    expect(world.store.get(LAST_ASKED)).toBe(NOW)
  })

  test('a turn that ends less than a minute after any session asked gets nothing new', OPTIONS, async ($, on) => {
    // Another session on this computer asked 59 seconds ago.
    const world = worldOf(on, { now: NOW + 59_000, store: { ...LINKED, [LAST_ASKED]: NOW } })

    await turn($, world)

    expect(world.requests).toEqual([])

    await world.clock.advance(1_000)
    await turn($, world, 't2')

    expect(to(world, '/api/ads/serve')).toHaveLength(1)
  })

  test('it asks again a minute later once the ad has been seen', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)
    await $.prompt.submit({ ...TYPED, text: 'next' })
    await world.clock.advance(30_000)
    await turn($, world, 't2')

    expect(to(world, '/api/ads/serve')).toHaveLength(1)

    await $.prompt.submit({ ...TYPED, text: 'and again' })
    await world.clock.advance(30_000)
    await turn($, world, 't3')

    expect(to(world, '/api/ads/serve')).toHaveLength(2)
  })

  test('nothing to show still counts as asking', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => json(200, { ad: null }) } })

    await turn($, world)
    await world.clock.advance(10_000)
    await turn($, world, 't2')

    expect(to(world, '/api/ads/serve')).toHaveLength(1)
  })

  test('a time from a clock that went backwards doesn\'t block it for good', OPTIONS, async ($, on) => {
    const world = worldOf(on, { now: NOW, store: { ...LINKED, [LAST_ASKED]: NOW + 100_000_000 } })

    await turn($, world)

    expect(to(world, '/api/ads/serve')).toHaveLength(1)
  })

  test('not being linked never counts as asking', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {} })

    await turn($, world)

    expect(world.store.has(LAST_ASKED)).toBe(false)
  })
})

describe('linking', () => {
  test('with no token, a turn starts a link and the band asks to connect', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {} })

    await turn($, world)

    expect(world.requests).toEqual([{
      method: 'POST',
      path: '/api/link',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { agent: 'claude-code' },
    }])

    const ui = await draw($, world)

    expect(await lineOf(ui)).toEqual(CONNECT_LINE)
    expect(to(world, SHOWN)).toEqual([])
    await ui.unmount()
  })

  test('the link is kept in the store every session shares, without the token', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {} })

    await turn($, world)

    expect(world.store.get(PENDING_LINK)).toEqual({
      deviceCode: 'device-1',
      userCode: 'ABCD-EFGH',
      uri: 'https://clickback.test/link',
      url: 'https://clickback.test/link?code=ABCD-EFGH',
      expiresAt: NOW + 900_000,
      interval: 5,
    })
    expect(world.store.has(TOKEN)).toBe(false)
  })

  test('the band asks as soon as the session starts', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {} })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await world.clock.settle()

    const ui = await band($)
    expect(await lineOf(ui)).toEqual(CONNECT_LINE)
    expect(to(world, '/api/link')).toHaveLength(1)
    await ui.unmount()
  })

  test('a session finds the link another session started and shows the same code', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: { [PENDING_LINK]: PENDING } })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await world.clock.settle()

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /\(code WXYZ-1234\)$/ })).toBeDefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://clickback.test/link?code=WXYZ-1234')
    expect(to(world, '/api/link')).toEqual([])

    await world.clock.advance(5_000)

    expect(to(world, '/api/link/token').map(request => request.body)).toEqual([{ device_code: 'device-0' }])
    await ui.unmount()
  })

  test('a link that has run out is replaced with a new one', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: { [PENDING_LINK]: { ...PENDING, expiresAt: NOW } } })

    await turn($, world)

    expect(to(world, '/api/link')).toHaveLength(1)
    expect((world.store.get(PENDING_LINK) as PendingLink).userCode).toBe('ABCD-EFGH')
  })

  test('it polls every interval while pending, then keeps the token and clears the line', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      store: {},
      routes: { '/api/link/token': inTurn(json(202, { status: 'pending' }), json(200, { status: 'linked', token: 'new-token' })) },
    })

    await turn($, world)
    await world.clock.advance(4_999)

    expect(to(world, '/api/link/token')).toEqual([])

    await world.clock.advance(1)

    expect(to(world, '/api/link/token')).toEqual([{
      method: 'POST',
      path: '/api/link/token',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { device_code: 'device-1' },
    }])

    const ui = await band($)
    expect(await lineOf(ui)).toEqual(CONNECT_LINE)

    await world.clock.advance(5_000)

    expect(world.store.get(TOKEN)).toBe('new-token')
    expect(world.store.has(PENDING_LINK)).toBe(false)
    expect(await ui.find({ type: 'Text', text: /Clickback/ })).toBeUndefined()

    await world.clock.advance(60_000)

    expect(to(world, '/api/link/token')).toHaveLength(2)
    await ui.unmount()

    await turn($, world, 't2')

    expect(to(world, '/api/ads/serve').map(request => request.headers.Authorization)).toEqual(['Bearer new-token'])
  })

  for (const [name, status] of [['denied', 403], ['expired', 410]] as const) {
    test(`a link that is ${name} is dropped and polling stops; a later turn starts another`, OPTIONS, async ($, on) => {
      const world = worldOf(on, { store: {}, routes: { '/api/link/token': () => json(status, { status: name }) } })

      await turn($, world)
      await world.clock.advance(5_000)

      const ui = await band($)
      expect(await ui.find({ type: 'Text', text: /Clickback/ })).toBeUndefined()
      expect(world.store.has(PENDING_LINK)).toBe(false)
      expect(world.store.has(LINK_POLLED)).toBe(false)
      expect(world.store.has(TOKEN)).toBe(false)

      await world.clock.advance(30_000)
      expect(to(world, '/api/link/token')).toHaveLength(1)

      await turn($, world, 't2')
      expect(to(world, '/api/link')).toHaveLength(2)
      expect(await lineOf(ui)).toEqual(CONNECT_LINE)
      await ui.unmount()
    })
  }

  test('a 410 after another session got the token counts as linked', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      store: {},
      routes: {
        '/api/link/token': () => {
          world.store.set(TOKEN, 'other-token')
          world.store.delete(PENDING_LINK)

          return json(410, { status: 'expired' })
        },
      },
    })

    await turn($, world)
    await world.clock.advance(5_000)

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Clickback/ })).toBeUndefined()
    expect(world.store.get(TOKEN)).toBe('other-token')

    await world.clock.advance(60_000)
    await turn($, world, 't2')

    expect(to(world, '/api/link/token')).toHaveLength(1)
    expect(to(world, '/api/link')).toHaveLength(1)
    expect(to(world, '/api/ads/serve').map(request => request.headers.Authorization)).toEqual(['Bearer other-token'])
    await ui.unmount()
  })

  test('once another session has linked, polling stops without asking the server', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {} })

    await turn($, world)
    await world.clock.advance(5_000)

    world.store.set(TOKEN, 'other-token')
    await world.clock.advance(5_000)

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Clickback/ })).toBeUndefined()
    expect(to(world, '/api/link/token')).toHaveLength(1)
    await ui.unmount()
  })

  test('polling stops when the link runs out', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {}, routes: { '/api/link': () => json(201, { ...LINK, expires_in: 12 }) } })

    await turn($, world)
    await world.clock.advance(15_000)

    const ui = await band($)
    expect(to(world, '/api/link/token')).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /Clickback/ })).toBeUndefined()
    expect(world.store.has(PENDING_LINK)).toBe(false)

    await world.clock.advance(30_000)
    expect(to(world, '/api/link/token')).toHaveLength(2)
    await ui.unmount()
  })

  test('a session start and several turns poll once per interval', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {} })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await world.clock.settle()
    await turn($, world)
    await turn($, world, 't2')
    await world.clock.advance(5_000)

    expect(to(world, '/api/link')).toHaveLength(1)
    expect(to(world, '/api/link/token')).toHaveLength(1)
  })

  describe('taking turns with the other sessions', () => {
    // A test loads one copy of the mod, so the other session is played here
    // by what it leaves in the store every session shares: the time it last
    // polled this link, written just before its request goes out.
    function otherSessionPolls(world: World, deviceCode = 'device-1') {
      world.store.set(LINK_POLLED, { deviceCode, at: world.clock.now() })
    }

    test('the time of each poll is in the shared store before the request goes out', OPTIONS, async ($, on) => {
      const stamps: unknown[] = []
      const world = worldOf(on, {
        store: {},
        routes: {
          '/api/link/token': () => {
            stamps.push(world.store.get(LINK_POLLED))

            return json(202, { status: 'pending' })
          },
        },
      })

      await turn($, world)
      await world.clock.advance(10_000)

      expect(stamps).toEqual([
        { deviceCode: 'device-1', at: NOW + 5_000 },
        { deviceCode: 'device-1', at: NOW + 10_000 },
      ])
    })

    test('while another session polls each interval, this one leaves it to that one', OPTIONS, async ($, on) => {
      const world = worldOf(on, { store: {} })

      // This session's timer ticks at 5s, 10s, ...; the other's at 2s, 7s, ...
      await turn($, world)

      for (let interval = 0; interval < 4; interval++) {
        await world.clock.advance(2_000)
        otherSessionPolls(world)
        await world.clock.advance(3_000)
      }

      expect(to(world, '/api/link/token')).toEqual([])

      const ui = await band($)
      expect(await lineOf(ui)).toEqual(CONNECT_LINE)
      await ui.unmount()
    })

    test('when the other session stops polling, this one takes over', OPTIONS, async ($, on) => {
      const world = worldOf(on, { store: {} })

      await turn($, world)
      await world.clock.advance(2_000)
      otherSessionPolls(world)
      await world.clock.advance(5_000)
      otherSessionPolls(world)

      // The other session closes at 7s. This one's tick at 10s is still too soon after it.
      await world.clock.advance(3_000)
      expect(to(world, '/api/link/token')).toEqual([])

      await world.clock.advance(5_000)
      expect(to(world, '/api/link/token')).toHaveLength(1)

      await world.clock.advance(5_000)
      expect(to(world, '/api/link/token')).toHaveLength(2)
    })

    for (const [after, polls] of [[5_000 - POLL_SLACK_MS, 1], [5_000 - POLL_SLACK_MS - 1, 0]] as const) {
      test(`a poll ${after}ms after another session's ${polls === 1 ? 'goes out' : 'waits'} (5s interval, ${POLL_SLACK_MS}ms of slack)`, OPTIONS, async ($, on) => {
        const world = worldOf(on, { store: {} })

        await turn($, world)
        await world.clock.advance(5_000 - after)
        otherSessionPolls(world)
        await world.clock.advance(after)

        expect(to(world, '/api/link/token')).toHaveLength(polls)
      })
    }

    for (const [name, stamp] of [
      ['another link\'s poll', { deviceCode: 'device-0', at: NOW + 4_000 }],
      ['a time from a clock that went backwards', { deviceCode: 'device-1', at: NOW + 100_000_000 }],
    ] as const) {
      test(`${name} doesn't hold this link's poll back`, OPTIONS, async ($, on) => {
        const world = worldOf(on, { store: {} })

        await turn($, world)
        world.store.set(LINK_POLLED, stamp)
        await world.clock.advance(5_000)

        expect(to(world, '/api/link/token')).toHaveLength(1)
      })
    }
  })

  test('a link the server won\'t start shows nothing, and the next turn tries again', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {}, routes: { '/api/link': inTurn(json(500, {}), json(201, LINK)) } })

    await turn($, world)

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Clickback/ })).toBeUndefined()
    expect(world.store.has(PENDING_LINK)).toBe(false)

    await turn($, world, 't2')
    expect(await lineOf(ui)).toEqual(CONNECT_LINE)
    await ui.unmount()
  })

  test('a local http approval page is still one Link (plain text in the Desktop app), and the line wraps', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      store: {},
      routes: {
        '/api/link': () => json(201, {
          ...LINK,
          verification_uri: 'http://clickback.test/link',
          verification_uri_complete: 'http://clickback.test/link?code=ABCD-EFGH',
        }),
      },
    })

    await turn($, world)

    const text = 'Clickback · Connect this computer to start earning: http://clickback.test/link (code ABCD-EFGH)'

    for (const [surface, line] of [
      ['terminal', linked('http://clickback.test/link?code=ABCD-EFGH', text)],
      ['desktop', plain(text)],
    ] as const) {
      const ui = await band($, surface)

      expect(await lineOf(ui)).toEqual(line)
      expect((await ui.find({ type: 'Text' }))?.props.wrap).toBe('wrap')
      await ui.unmount()
    }
  })

  test(`an approval page address over ${MAX_HREF} characters shows no line`, OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      store: {},
      routes: { '/api/link': () => json(201, { ...LINK, verification_uri_complete: `https://clickback.test/link?code=${'A'.repeat(MAX_HREF)}` }) },
    })

    await turn($, world)

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Clickback/ })).toBeUndefined()
    expect(world.store.has(PENDING_LINK)).toBe(false)
    await ui.unmount()
  })

  test('the desktop app is asked the same way, as claude-code-desktop', OPTIONS, async ($, on) => {
    const world = worldOf(on, { store: {}, surfaces: ['desktop'] })

    await turn($, world)

    const ui = await band($, 'desktop')
    expect(to(world, '/api/link')[0]?.body).toEqual({ agent: 'claude-code-desktop' })
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://clickback.test/link?code=ABCD-EFGH')
    await ui.unmount()
  })

  test('a refused token (401) is deleted and the band asks to connect again', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => json(401, { message: 'Unauthenticated.' }) } })

    await turn($, world)

    expect(world.store.has(TOKEN)).toBe(false)
    expect(to(world, '/api/link')).toHaveLength(1)

    const ui = await band($)
    expect(await lineOf(ui)).toEqual(CONNECT_LINE)
    await ui.unmount()
  })

  test('a 401 leaves alone a new token another session stored meanwhile', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      routes: {
        '/api/ads/serve': () => {
          world.store.set(TOKEN, 'fresh-token')

          return json(401, { message: 'Unauthenticated.' })
        },
      },
    })

    await turn($, world)

    expect(world.store.get(TOKEN)).toBe('fresh-token')
    expect(to(world, '/api/link')).toEqual([])
  })
})

describe('confirming the ad was drawn', () => {
  test('the first draw confirms it once, with the ad token', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    expect(to(world, SHOWN)).toEqual([])

    const ui = await draw($, world)

    expect(to(world, SHOWN)).toEqual([{
      method: 'POST',
      path: SHOWN,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ad-token' },
      body: {},
    }])

    await ui.redraw({ ...BAND, bodyColumns: 80 })
    await world.clock.settle()
    await ui.unmount()

    const desktop = await draw($, world, 'desktop')
    expect(await desktop.find({ type: 'Link' })).toBeDefined()
    expect(to(world, SHOWN)).toHaveLength(1)
    expect(to(world, '/api/ads/serve')).toHaveLength(1)
    await desktop.unmount()
  })

  test('a band that yields confirms nothing', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    for (const props of [
      { ...BAND, hasSurvey: true },
      { ...BAND, isWorking: true },
      { ...BAND, view: { agentId: 'agent-1' } },
    ]) {
      const ui = await draw($, world, 'terminal', props)
      await ui.unmount()
    }

    expect(to(world, SHOWN)).toEqual([])

    const ui = await draw($, world)
    expect(to(world, SHOWN)).toHaveLength(1)
    await ui.unmount()
  })

  test('a draw while the confirmation is under way sends nothing more', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { [SHOWN]: () => world.clock.sleep(2_000).then(() => json(200, { shown: true, charged: true })) } })

    await turn($, world)

    const ui = await draw($, world)
    await ui.redraw({ ...BAND, bodyColumns: 80 })
    await world.clock.advance(2_000)
    await ui.redraw(BAND)
    await world.clock.settle()

    expect(to(world, SHOWN)).toHaveLength(1)
    await ui.unmount()
  })

  for (const [name, status, body] of [
    ['an ad that expired (410)', 410, { shown: false, reason: 'expired' }],
    ['an ad the server doesn\'t know (404)', 404, { message: 'Not found' }],
  ] as const) {
    test(`${name} isn't confirmed again`, OPTIONS, async ($, on) => {
      const world = worldOf(on, { routes: { [SHOWN]: () => json(status, body) } })

      await turn($, world)

      const ui = await draw($, world)
      await ui.redraw({ ...BAND, bodyColumns: 80 })
      await world.clock.settle()

      expect(to(world, SHOWN)).toHaveLength(1)
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      expect(world.store.get(TOKEN)).toBe('ad-token')
      await ui.unmount()
    })
  }

  test(`a failed confirmation is tried again on later draws, ${CONFIRM_TRIES} times at most`, OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      routes: { [SHOWN]: inTurn(json(500, {}), json(503, {}), json(500, {}), json(200, { shown: true, charged: true })) },
    })

    await turn($, world)

    const ui = await draw($, world)

    for (const columns of [80, 90, 100, 110]) {
      await ui.redraw({ ...BAND, bodyColumns: columns })
      await world.clock.settle()
    }

    expect(to(world, SHOWN)).toHaveLength(CONFIRM_TRIES)
    await ui.unmount()
  })

  test('a confirmation with no answer in 3 seconds is tried again on the next draw', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      routes: { [SHOWN]: inTurn(new Promise<never>(() => {}) as never, json(200, { shown: true, charged: true })) },
    })

    await turn($, world)

    const ui = await draw($, world)
    await world.clock.advance(3_000)
    await ui.redraw({ ...BAND, bodyColumns: 80 })
    await world.clock.settle()
    await ui.redraw(BAND)
    await world.clock.settle()

    expect(to(world, SHOWN)).toHaveLength(2)
    await ui.unmount()
  })

  test('a refused token (401) is deleted and linking starts', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { [SHOWN]: () => json(401, { message: 'Unauthenticated.' }) } })

    await turn($, world)

    const ui = await draw($, world)

    expect(world.store.has(TOKEN)).toBe(false)
    expect(to(world, '/api/link')).toHaveLength(1)

    await $.prompt.submit({ ...TYPED, text: 'next' })

    expect(await lineOf(ui)).toEqual(CONNECT_LINE)
    expect(to(world, SHOWN)).toHaveLength(1)
    await ui.unmount()
  })
})

describe('the debug log', () => {
  test('its reasons go to the debug log', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => json(200, { ad: null }) } })

    await turn($, world)

    expect(world.logs).toEqual([
      { text: 'asking for an ad', to: 'debug' },
      { text: 'no ad this time', to: 'debug' },
    ])
  })

  test('from linking to a confirmed ad, it never adds a line to the transcript', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      store: {},
      routes: { '/api/link/token': inTurn(json(202, { status: 'pending' }), json(200, { status: 'linked', token: 't' })) },
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await world.clock.settle()
    await world.clock.advance(10_000)
    await turn($, world)
    await (await draw($, world)).unmount()
    await $.prompt.submit({ ...TYPED, text: 'next' })

    expect(to(world, SHOWN)).toHaveLength(1)
    expect(world.logs.length).toBeGreaterThan(5)
    expect(world.logs.filter(line => line.to !== 'debug')).toEqual([])
  })

  test('an ad, and its confirmation, are logged', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { [SHOWN]: () => json(200, { shown: true, charged: false }) } })

    await turn($, world)
    await (await draw($, world)).unmount()

    expect(world.logs.map(line => line.text)).toEqual([
      'asking for an ad',
      'got ad 41 from shipfast.example.com',
      'confirmed ad 41 as shown, charged: no',
    ])
  })

  test('a failed confirmation says why', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { [SHOWN]: () => json(500, {}) } })

    await turn($, world)
    await (await draw($, world)).unmount()

    expect(world.logs.at(-1)?.text).toBe('confirming ad 41 failed: HTTP 500')
  })

  test('each step of linking is logged', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      store: {},
      routes: { '/api/link/token': inTurn(json(202, { status: 'pending' }), json(202, { status: 'pending' }), json(200, { status: 'linked', token: 't' })) },
    })

    await turn($, world)
    await world.clock.advance(15_000)

    expect(world.logs.map(line => line.text)).toEqual([
      'this computer is not linked yet, so not asking',
      'linking this computer to Clickback',
      'showing the code ABCD-EFGH',
      'code ABCD-EFGH is still waiting to be approved',
      'code ABCD-EFGH is still waiting to be approved',
      'linked this computer',
    ])
  })

  test('a server error says which', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => json(500, {}) } })

    await turn($, world)

    expect(world.logs.map(line => line.text)).toEqual(['asking for an ad', 'asking for an ad failed: HTTP 500'])
  })

  test('a request that fails says why', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => new Error('ECONNREFUSED') } })

    await turn($, world)

    expect(world.logs.map(line => line.text)).toEqual([
      'asking for an ad',
      expect.stringMatching(/^asking for an ad failed: .*ECONNREFUSED/),
    ])
  })

  test('a request it stopped waiting for says so, and how it ended', OPTIONS, async ($, on) => {
    const world = worldOf(on, { routes: { '/api/ads/serve': () => world.clock.sleep(10_000).then(() => served()) } })

    await $.turn.complete(ANSWERED)
    await world.clock.advance(3_000)

    expect(world.logs.at(-1)?.text).toBe('asking for an ad failed: no answer within 3000ms')

    await world.clock.advance(10_000)

    expect(world.logs.at(-1)?.text).toBe('asking for an ad: answered after the limit (HTTP 200), so it was ignored')
  })

  test('where nothing draws the band, it says that is why it did not ask', OPTIONS, async ($, on) => {
    const world = worldOf(on, { surfaces: ['vscode'] })

    await turn($, world)

    expect(world.logs).toEqual([{ text: 'nothing here draws the band (vscode), so not asking', to: 'debug' }])
  })
})
