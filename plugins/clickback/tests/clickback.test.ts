import type { HttpInit, HttpResponse, On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const OPTIONS = { options: { api_token: '1|secret-token', base_url: 'https://clickback.test/' } }

const SERVED = {
  impression_id: '01K6ABC',
  label: 'Sponsored',
  advertiser: 'Shipfast',
  headline: 'Deploy Laravel apps in 30 seconds',
  body: null,
  destination_host: 'shipfast.example.com',
  tracking_url: 'https://clickback.test/c/yQyJU8XBGHxG',
  text: 'Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → shipfast.example.com · https://clickback.test/c/yQyJU8XBGHxG',
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

type Request = { url: string; init?: HttpInit }

type World = {
  requests: Request[]
  clock: ReturnType<typeof mock.clock>
}

function ok(body: unknown, status = 200): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: typeof body === 'string' ? body : JSON.stringify(body) }
}

/**
 * A 200 from the serve endpoint, wrapped in "data" as the Laravel resource is.
 */
function served(changes: Record<string, unknown> = {}): HttpResponse {
  return ok({ data: { ...SERVED, ...changes } })
}

/**
 * Everything beneath the mod: the session, the server, the clock, the band
 * Claude Code leaves empty, and the bottom of a turn and a prompt.
 */
function worldOf(
  on: On,
  respond: (request: Request) => HttpResponse | Promise<HttpResponse> = () => served(),
  surfaces: readonly RenderSurface[] = ['terminal'],
): World {
  const requests: Request[] = []
  const clock = mock.clock(on)

  on('session.surfaces', () => ({ value: surfaces }))
  on('session.id', () => ({ value: 'session-1' }))
  on('http.fetch', async ($, e) => {
    requests.push({ url: e.url, init: e.init })

    return { value: await respond({ url: e.url, init: e.init }) }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

  return { requests, clock }
}

function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal', props = BAND) {
  return $.ui.mount({ plugin: 'clickback', surface, component: 'AbovePrompt', props })
}

describe('clickback', () => {
  test('after a turn the band shows one labelled line linking to the tracking URL', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    const ui = await band($)
    const line = await ui.find({ type: 'Text', text: /^Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → / })
    const link = await ui.find({ type: 'Link' })

    expect(line).toBeDefined()
    expect(link?.children).toEqual(['shipfast.example.com'])
    expect(link?.props.href).toBe('https://clickback.test/c/yQyJU8XBGHxG')
    await ui.unmount()
  })

  test('it asks the serve endpoint with the token, surface=mod and the session id', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    expect(world.requests).toHaveLength(1)
    expect(world.requests[0]?.url).toBe('https://clickback.test/api/v1/ads/serve')
    expect(world.requests[0]?.init?.method).toBe('POST')
    expect(world.requests[0]?.init?.headers?.Authorization).toBe('Bearer 1|secret-token')
    expect(JSON.parse(world.requests[0]?.init?.body ?? '{}')).toEqual({
      surface: 'mod',
      agent: 'claude-code',
      session_id: 'session-1',
    })
  })

  test('the next prompt takes the ad down and goes to Claude untouched', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

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

    await $.turn.complete(ANSWERED)
    await world.clock.settle()
    await $.turn.complete({ ...ANSWERED, turnId: 't2' })
    await world.clock.settle()

    expect(world.requests).toHaveLength(1)
  })

  test('drawing the band again never asks the server', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    const ui = await band($)
    await ui.redraw(BAND)
    await ui.redraw({ ...BAND, bodyColumns: 80 })

    expect(world.requests).toHaveLength(1)
    await ui.unmount()
  })

  test('an ad that lands after the next prompt waits for that turn to end', OPTIONS, async ($, on) => {
    let answer: (response: HttpResponse) => void = () => {}
    const world = worldOf(on, () => new Promise(resolve => (answer = resolve)))

    await $.turn.complete(ANSWERED)
    await world.clock.settle()
    await $.prompt.submit({ ...TYPED, text: 'quick follow-up' })
    answer(served())
    await world.clock.settle()

    const working = await band($, 'terminal', { ...BAND, isWorking: true })
    expect(await working.find({ type: 'Link' })).toBeUndefined()
    await working.unmount()

    await $.turn.complete({ ...ANSWERED, turnId: 't2' })
    await world.clock.settle()

    const idle = await band($)
    expect(await idle.find({ type: 'Link' })).toBeDefined()
    expect(world.requests).toHaveLength(1)
    await idle.unmount()

    await $.prompt.submit({ ...TYPED, text: 'and another' })

    const after = await band($)
    expect(await after.find({ type: 'Link' })).toBeUndefined()
    await after.unmount()
  })

  test('the desktop app gets the same line, reported as claude-code-desktop', OPTIONS, async ($, on) => {
    const world = worldOf(on, () => served(), ['desktop'])

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    const ui = await band($, 'desktop')
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://clickback.test/c/yQyJU8XBGHxG')
    expect(JSON.parse(world.requests[0]?.init?.body ?? '{}').agent).toBe('claude-code-desktop')
    await ui.unmount()
  })

  test('claude -p and the SDK draw nowhere, so the server is never asked', OPTIONS, async ($, on) => {
    const world = worldOf(on, () => served(), [])

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    expect(world.requests).toEqual([])
  })

  test('a surface without the band (VS Code, mobile) is never asked for', OPTIONS, async ($, on) => {
    const world = worldOf(on, () => served(), ['vscode', 'mobile'])

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

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
    ['nothing to show (204)', ok('', 204)],
    ['a bad token (401)', ok({ message: 'Unauthenticated.' }, 401)],
    ['a server error (500)', ok('<html>oops</html>', 500)],
    ['a body that is not JSON', ok('not json')],
    ['an ad that is not wrapped in data', ok(SERVED)],
    ['an ad with no link', served({ tracking_url: 'javascript:alert(1)' })],
    ['an ad with no headline', served({ headline: '' })],
  ] as const) {
    test(`${name} shows nothing`, OPTIONS, async ($, on) => {
      const world = worldOf(on, () => response)

      await $.turn.complete(ANSWERED)
      await world.clock.settle()

      const ui = await band($)
      expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('a failed request shows nothing and leaves the turn alone', OPTIONS, async ($, on) => {
    const world = worldOf(on, () => Promise.reject(new Error('ECONNREFUSED')))

    expect(await $.turn.complete(ANSWERED)).toEqual({ text: 'ok' })
    await world.clock.settle()

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a slow server is given up on after 3 seconds', OPTIONS, async ($, on) => {
    const world = worldOf(on, () => world.clock.sleep(10_000).then(() => served()))

    await $.turn.complete(ANSWERED)
    await world.clock.advance(3_000)

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()

    await world.clock.advance(10_000)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the turn finishes before the server answers', OPTIONS, async ($, on) => {
    const world = worldOf(on, () => world.clock.sleep(2_000).then(() => served()))

    expect(await $.turn.complete(ANSWERED)).toEqual({ text: 'ok' })
    expect(world.clock.now()).toBe(0)

    await world.clock.advance(2_000)

    const ui = await band($)
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  })

  test('with no token the server is never asked', { options: { api_token: '   ' } }, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    expect(world.requests).toEqual([])
  })

  test('the default server is clickback.dev', { options: { api_token: '1|secret-token' } }, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    expect(world.requests[0]?.url).toBe('https://clickback.dev/api/v1/ads/serve')
  })

  test('a link a Link would refuse (a local http server) is drawn as text', {
    options: { api_token: '1|secret-token', base_url: 'http://clickback.test' },
  }, async ($, on) => {
    const world = worldOf(on, () => served({ tracking_url: 'http://clickback.test/c/abc' }))

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    const ui = await band($)
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /→ shipfast\.example\.com · http:\/\/clickback\.test\/c\/abc$/ })).toBeDefined()
    await ui.unmount()
  })

  test('control characters and terminal escapes from the server are flattened', OPTIONS, async ($, on) => {
    const world = worldOf(on, () =>
      served({ advertiser: 'Ship\u001b]8;;https://evil.example\u0007fast', headline: 'Line one\nline two\u202e' }),
    )

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    const ui = await band($)
    const line = await ui.find({ type: 'Text', text: /Sponsored/ })
    expect(line?.text).toStartWith('Sponsored · Ship ]8;;https://evil.example fast: Line one line two → ')
    expect(line?.text).not.toMatch(/[\u0000-\u001f\u202e]/)
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

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^Sponsored/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Clear skies' })).toBeDefined()
    await ui.unmount()
  })

  test('the band yields to a survey, a running turn and an agent view', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete(ANSWERED)
    await world.clock.settle()

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
