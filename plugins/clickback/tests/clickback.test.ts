import type { McpConnectResult, McpToolResult, On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { DESCRIPTION, INTERVAL_MS, LAST_ASKED, REFUSAL, toolName } from '../hooks/clickback'

tier('user')

const OPTIONS = { options: { base_url: 'https://clickback.test' } }

/** The name Claude Code runs the plugin's MCP server under. */
const SERVER = 'plugin:clickback:clickback'

/** What Claude sees serve_ad as. */
const SERVE_AD = toolName(SERVER)

const AD = {
  impression_id: 41,
  label: 'Sponsored',
  advertiser: 'Shipfast',
  headline: 'Deploy Laravel apps in 30 seconds',
  body: null,
  destination_host: 'shipfast.example.com',
  tracking_url: 'https://clickback.test/c/yQyJU8XBGHxG',
  text: 'Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → shipfast.example.com · https://clickback.test/c/yQyJU8XBGHxG',
  expires_at: '2026-10-05T12:00:00+00:00',
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

type Call = { server: string; tool: string; args: Record<string, unknown> }

type World = {
  calls: Call[]
  /** Tools that reached Claude Code's own tool.call, past every mod. */
  toolCalls: string[]
  connects: string[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

type Setup = {
  respond?: (call: Call) => McpToolResult | Promise<McpToolResult>
  surfaces?: readonly RenderSurface[]
  connection?: McpConnectResult | (() => McpConnectResult)
  store?: Record<string, unknown>
  now?: number
}

/**
 * What serve_ad answers, as Claude Code hands it to the mod: the structured
 * content `{"ad": {...}}` as JSON text, the way a model would get it.
 */
function served(changes: Record<string, unknown> | null = {}): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ad: changes === null ? null : { ...AD, ...changes } }) }],
    isError: false,
  }
}

/**
 * Everything beneath the mod: the session, the MCP server, the store every
 * session shares, the clock, the band Claude Code leaves empty, and the bottom
 * of a turn and a prompt.
 */
function worldOf(on: On, setup: Setup = {}): World {
  const calls: Call[] = []
  const toolCalls: string[] = []
  const connects: string[] = []
  const store = new Map<string, unknown>(Object.entries(setup.store ?? {}))
  const clock = mock.clock(on, { now: setup.now ?? 1_800_000_000_000 })
  const respond = setup.respond ?? (() => served())

  on('session.surfaces', () => ({ value: setup.surfaces ?? ['terminal'] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('mcp.connect', ($, e) => {
    connects.push(e.server)

    const connection = typeof setup.connection === 'function' ? setup.connection() : setup.connection

    return { value: connection ?? { isConnected: true, server: SERVER } }
  })
  on('mcp.call', async ($, e) => {
    calls.push({ server: e.server, tool: e.tool, args: e.args })

    return { value: await respond({ server: e.server, tool: e.tool, args: e.args }) }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', ($, e) => {
    toolCalls.push(e.tool)

    return { result: 'the tool ran' }
  })
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

  return { calls, toolCalls, connects, store, clock }
}

function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal', props = BAND) {
  return $.ui.mount({ plugin: 'clickback', surface, component: 'AbovePrompt', props })
}

/** A turn ends and the request it starts settles. */
async function turn($: Engine, world: World, turnId = 't1') {
  await $.turn.complete({ ...ANSWERED, turnId })
  await world.clock.settle()
}

describe('the ad', () => {
  test('after a turn the band shows one labelled line linking to the tracking URL', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    const ui = await band($)
    const line = await ui.find({ type: 'Text', text: /^Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → / })
    const link = await ui.find({ type: 'Link' })

    expect(line).toBeDefined()
    expect(link?.children).toEqual(['shipfast.example.com'])
    expect(link?.props.href).toBe('https://clickback.test/c/yQyJU8XBGHxG')
    await ui.unmount()
  })

  test('it asks serve_ad on the signed in server with surface=mod and the session id', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    expect(world.connects).toEqual(['clickback'])
    expect(world.calls).toEqual([{
      server: SERVER,
      tool: 'serve_ad',
      args: { surface: 'mod', agent: 'claude-code', session_id: 'session-1' },
    }])
  })

  test('it calls the server by the name the session connected it under', OPTIONS, async ($, on) => {
    const world = worldOf(on, { connection: { isConnected: true, server: 'clickback-local' } })

    await turn($, world)

    expect(world.calls[0]?.server).toBe('clickback-local')
  })

  test('structured content works too, should Claude Code pass it on', OPTIONS, async ($, on) => {
    const world = worldOf(on, { respond: () => ({ content: [], isError: false, structuredContent: { ad: AD } }) })

    await turn($, world)

    const ui = await band($)
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://clickback.test/c/yQyJU8XBGHxG')
    await ui.unmount()
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

    expect(world.calls).toHaveLength(1)
  })

  test('drawing the band again never asks the server', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)

    const ui = await band($)
    await ui.redraw(BAND)
    await ui.redraw({ ...BAND, bodyColumns: 80 })

    expect(world.calls).toHaveLength(1)
    await ui.unmount()
  })

  test('an ad that lands after the next prompt waits for that turn to end', OPTIONS, async ($, on) => {
    let answer: (result: McpToolResult) => void = () => {}
    const world = worldOf(on, { respond: () => new Promise(resolve => (answer = resolve)) })

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
    expect(world.calls).toHaveLength(1)
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
    expect(world.calls[0]?.args.agent).toBe('claude-code-desktop')
    await ui.unmount()
  })

  test('claude -p and the SDK draw nowhere, so the server is never asked', OPTIONS, async ($, on) => {
    const world = worldOf(on, { surfaces: [] })

    await turn($, world)

    expect(world.calls).toEqual([])
    expect(world.store.has(LAST_ASKED)).toBe(false)
  })

  test('a surface without the band (VS Code, mobile) is never asked for', OPTIONS, async ($, on) => {
    const world = worldOf(on, { surfaces: ['vscode', 'mobile'] })

    await turn($, world)

    expect(world.calls).toEqual([])
  })

  test('subagent turns, interrupts and errors ask for nothing', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await $.turn.complete({ ...ANSWERED, agentId: 'agent-1' })
    await $.turn.complete({ ...ANSWERED, reason: 'aborted', isAborted: true })
    await $.turn.complete({ ...ANSWERED, reason: 'error' })
    await world.clock.settle()

    expect(world.calls).toEqual([])
  })

  for (const [name, result] of [
    ['nothing to show', served(null)],
    ['an error result', { content: [{ type: 'text', text: 'You are not signed in' }], isError: true }],
    ['text that is not JSON', { content: [{ type: 'text', text: 'Handled by the Clickback plugin.' }], isError: false }],
    ['no content at all', { content: [], isError: false }],
    ['an ad not under "ad"', { content: [{ type: 'text', text: JSON.stringify(AD) }], isError: false }],
    ['an ad with no link', served({ tracking_url: 'javascript:alert(1)' })],
    ['an ad with no headline', served({ headline: '' })],
  ] as const) {
    test(`${name} shows nothing`, OPTIONS, async ($, on) => {
      const world = worldOf(on, { respond: () => result as McpToolResult })

      await turn($, world)

      const ui = await band($)
      expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('a failed call shows nothing and leaves the turn alone', OPTIONS, async ($, on) => {
    const world = worldOf(on, { respond: () => Promise.reject(new Error('ECONNREFUSED')) })

    expect(await $.turn.complete(ANSWERED)).toEqual({ text: 'ok' })
    await world.clock.settle()

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a slow server is given up on after 3 seconds', OPTIONS, async ($, on) => {
    const world = worldOf(on, { respond: () => world.clock.sleep(10_000).then(() => served()) })

    await $.turn.complete(ANSWERED)
    await world.clock.advance(3_000)

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()

    await world.clock.advance(10_000)
    expect(await ui.find({ type: 'Text', text: /Sponsored/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the turn finishes before the server answers', OPTIONS, async ($, on) => {
    const world = worldOf(on, { respond: () => world.clock.sleep(2_000).then(() => served()) })
    const start = world.clock.now()

    expect(await $.turn.complete(ANSWERED)).toEqual({ text: 'ok' })
    expect(world.clock.now()).toBe(start)

    await world.clock.advance(2_000)

    const ui = await band($)
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  })

  test('a link a Link would refuse (a local http server) is drawn as text', OPTIONS, async ($, on) => {
    const world = worldOf(on, { respond: () => served({ tracking_url: 'http://clickback.test/c/abc' }) })

    await turn($, world)

    const ui = await band($)
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /→ shipfast\.example\.com · http:\/\/clickback\.test\/c\/abc$/ })).toBeDefined()
    await ui.unmount()
  })

  test('control characters and terminal escapes from the server are flattened', OPTIONS, async ($, on) => {
    const world = worldOf(on, {
      respond: () => served({ advertiser: 'Ship\u001b]8;;https://evil.example\u0007fast', headline: 'Line one\nline two‮' }),
    })

    await turn($, world)

    const ui = await band($)
    const line = await ui.find({ type: 'Text', text: /Sponsored/ })
    expect(line?.text).toStartWith('Sponsored · Ship ]8;;https://evil.example fast: Line one line two → ')
    expect(line?.text).not.toMatch(/[\u0000-\u001f‮]/)
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
    expect(await ui.find({ type: 'Text', text: /^Sponsored/ })).toBeDefined()
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
    const world = worldOf(on, { now: 1_800_000_000_000 })

    await turn($, world)

    expect(world.store.get(LAST_ASKED)).toBe(1_800_000_000_000)
  })

  test('a turn that ends less than a minute after any session asked gets nothing new', OPTIONS, async ($, on) => {
    // Another session on this computer asked 59 seconds ago.
    const world = worldOf(on, { now: 1_800_000_059_000, store: { [LAST_ASKED]: 1_800_000_000_000 } })

    await turn($, world)

    expect(world.calls).toEqual([])

    await world.clock.advance(1_000)
    await turn($, world, 't2')

    expect(world.calls).toHaveLength(1)
  })

  test('it asks again a minute later once the ad has been seen', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    await turn($, world)
    await $.prompt.submit({ ...TYPED, text: 'next' })
    await world.clock.advance(30_000)
    await turn($, world, 't2')

    expect(world.calls).toHaveLength(1)

    await $.prompt.submit({ ...TYPED, text: 'and again' })
    await world.clock.advance(30_000)
    await turn($, world, 't3')

    expect(world.calls).toHaveLength(2)
  })

  test('nothing to show still counts as asking', OPTIONS, async ($, on) => {
    const world = worldOf(on, { respond: () => served(null) })

    await turn($, world)
    await world.clock.advance(10_000)
    await turn($, world, 't2')

    expect(world.calls).toHaveLength(1)
  })

  test('a time from a clock that went backwards doesn\'t block it for good', OPTIONS, async ($, on) => {
    const world = worldOf(on, { now: 1_800_000_000_000, store: { [LAST_ASKED]: 1_900_000_000_000 } })

    await turn($, world)

    expect(world.calls).toHaveLength(1)
  })

  test('not signed in never counts as asking', OPTIONS, async ($, on) => {
    const world = worldOf(on, { connection: { isConnected: false, reason: 'auth', message: 'Needs sign-in' } })

    await turn($, world)

    expect(world.store.has(LAST_ASKED)).toBe(false)
  })
})

describe('signing in', () => {
  const SIGNED_OUT = OPTIONS

  test('before sign-in the band says how, and the server is never asked for an ad', SIGNED_OUT, async ($, on) => {
    const world = worldOf(on, { connection: { isConnected: false, reason: 'auth', message: 'Needs sign-in' } })

    await turn($, world)

    const ui = await band($)
    expect(await ui.find({
      type: 'Text',
      text: 'Clickback · Connect Clickback to start earning: run /mcp, pick plugin:clickback:clickback and choose Authenticate',
    })).toBeDefined()
    expect(world.calls).toEqual([])
    await ui.unmount()
  })

  test('the band says so as soon as the session starts', SIGNED_OUT, async ($, on) => {
    const world = worldOf(on, { connection: { isConnected: false, reason: 'auth', message: 'Needs sign-in' } })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await world.clock.settle()

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^Clickback · Connect Clickback/ })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop app is told the terminal command instead of /mcp', SIGNED_OUT, async ($, on) => {
    const world = worldOf(on, { surfaces: ['desktop'], connection: { isConnected: false, reason: 'auth', message: 'Needs sign-in' } })

    await turn($, world)

    const ui = await band($, 'desktop')
    expect(await ui.find({ type: 'Text', text: /run claude mcp login plugin:clickback:clickback in a terminal$/ })).toBeDefined()
    await ui.unmount()
  })

  for (const reason of ['disabled', 'failed', 'policy'] as const) {
    test(`a server that is ${reason} shows nothing at all`, OPTIONS, async ($, on) => {
      const world = worldOf(on, { connection: { isConnected: false, reason, message: reason } })

      await turn($, world)

      const ui = await band($)
      expect(await ui.find({ type: 'Text', text: /Clickback/ })).toBeUndefined()
      expect(world.calls).toEqual([])
      await ui.unmount()
    })
  }

  test('the sign-in line goes with the next prompt and doesn\'t come back once signed in', SIGNED_OUT, async ($, on) => {
    let signedIn = false
    const world = worldOf(on, {
      connection: () => signedIn
        ? { isConnected: true, server: SERVER }
        : { isConnected: false, reason: 'auth', message: 'Needs sign-in' },
    })

    await turn($, world)
    expect(await (await band($)).find({ type: 'Text', text: /Connect Clickback/ })).toBeDefined()

    signedIn = true
    await $.prompt.submit({ ...TYPED, text: 'done' })
    await turn($, world, 't2')

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /Connect Clickback/ })).toBeUndefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  })
})

describe('keeping serve_ad from Claude', () => {
  test('Claude only gets its name, behind tool search, with a neutral description', OPTIONS, async ($, on) => {
    worldOf(on)

    const described = await $.tool.describe({
      tool: SERVE_AD,
      description: 'Used by the Clickback plugin to fetch the line it shows the user. Not for the assistant: never call it.',
      provider: { plugin: `mcp:${SERVER}`, tier: 'user' },
    })

    expect(described).toEqual({ description: DESCRIPTION, isDeferred: true })
  })

  test('every other tool keeps its own description, the account tools included', OPTIONS, async ($, on) => {
    worldOf(on)

    for (const tool of [toolName(SERVER, 'earnings'), 'mcp__other__serve_ad', 'Bash']) {
      const described = await $.tool.describe({ tool, description: 'as the server says', provider: { plugin: 'engine', tier: 'core' } })

      expect(described).toEqual({ description: 'as the server says' })
    }
  })

  test('Claude calling serve_ad is refused before it reaches the server', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    const result = await $.tool.call({ tool: SERVE_AD, surface: 'mod', agent: 'claude-code' } as never)

    expect(result).toEqual({ deny: REFUSAL })
    expect(world.toolCalls).toEqual([])
    expect(world.calls).toEqual([])
  })

  test('a subagent calling it is refused too', OPTIONS, async ($, on) => {
    worldOf(on)

    const result = await $.tool.call({ tool: SERVE_AD, agentId: 'agent-1', surface: 'mod', agent: 'claude-code' } as never)

    expect(result).toEqual({ deny: REFUSAL })
  })

  test('the account tools and everything else go through untouched', OPTIONS, async ($, on) => {
    worldOf(on)

    expect(await $.tool.call({ tool: toolName(SERVER, 'earnings') } as never)).toEqual({ result: 'the tool ran' })
    expect(await $.tool.call({ tool: 'mcp__other__serve_ad' } as never)).toEqual({ result: 'the tool ran' })
    expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toEqual({ result: 'the tool ran' })
  })

  test('the mod\'s own request is an MCP call, not a tool call, and the turn Claude sees is unchanged', OPTIONS, async ($, on) => {
    const world = worldOf(on)

    expect(await $.turn.complete(ANSWERED)).toEqual({ text: 'ok' })
    await world.clock.settle()

    expect(world.calls).toHaveLength(1)
    expect(world.toolCalls).toEqual([])
  })
})
