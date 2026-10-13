// Clickback mod: shows you one sponsored line above the prompt after Claude
// finishes a turn, and pays you for it.
//
// Display only. The ad is drawn in the AbovePrompt band and kept in $.state.
// It never goes to the model: this module adds no prompt context, rewrites no
// message and changes no tool call of Claude's. It touches one tool, serve_ad,
// the one this mod fetches ads with: Claude only sees its name behind tool
// search, with a neutral description, and any call to it from Claude is refused.
//
// Sign-in: there is no token here. You sign in to the plugin's MCP server once,
// with OAuth (/mcp, Authenticate), and this mod fetches ads through that same
// connection with $.mcp.call. Claude Code holds the token; the mod never sees
// it. Until you sign in, the band says how.
//
// $.mcp.call runs as a tool call, through the permission check, and a mod's own
// hooks don't see the calls it makes. So hooks.json also has a small
// PermissionRequest hook (allow-serve-ad.sh) that allows serve_ad only when the
// call carries this session's id, which is what this mod sends.
//
// It asks at most once a minute, across every Claude Code session on this
// computer (the time of the last ask is in $.store, which they all share).
// A turn that ends sooner shows nothing new. The server holds the same line.
//
// Privacy: it sends Clickback the session id, surface=mod and which app you
// are in. Your prompts, Claude's replies, the transcript and your working
// directory never leave this machine.
//
// It never gets in the way: the request runs after the turn has finished, gives
// up after a few seconds, and any failure (not signed in, no ad, a slow or
// broken server, a response it doesn't understand) shows no ad.

import type { EngineInterface, McpToolResult, On, RenderSurface } from 'claude-code'

import type { ClickbackAd } from '../types'

/** The ad on screen, held by the host so a hot reload keeps it. */
const AD = { plugin: 'clickback', key: 'ad' } as const

/** How many prompts this session has submitted so far. */
const PROMPTS = { plugin: 'clickback', key: 'prompts' } as const

/** The MCP server to sign in to, while the band should say so. */
const SIGN_IN = { plugin: 'clickback', key: 'signIn' } as const

export const LABEL = 'Sponsored'
export const SURFACE = 'mod'
export const TIMEOUT_MS = 3000

/** At most one ad request this often, from every session on the computer. */
export const INTERVAL_MS = 60_000

/** The $.store key holding when any session last asked, in epoch milliseconds. */
export const LAST_ASKED = 'lastAskedAt'

/** The server's key in .mcp.json. */
export const SERVER = 'clickback'

/** The MCP tool that serves an ad. Only this mod may call it. */
export const SERVE_TOOL = 'serve_ad'

/** What Claude reads about serve_ad, if it ever looks it up. */
export const DESCRIPTION = 'Internal to the Clickback plugin. Not for the assistant: calls are refused.'

export const REFUSAL = 'Clickback ads are shown to the user by the Clickback plugin, never by Claude. Do not call this tool.'

type Served = Omit<ClickbackAd, 'prompt'>

/** Only one serve request at a time. A reload resets it, which is harmless. */
let isServing = false

/** The name the session runs our server under, once it has connected. */
let connectedAs: string | undefined

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // Say so straight away if the server needs a sign-in, not only after a turn.
    void check($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Main-loop turns that finished normally. Subagents, interrupts, refusals
    // and API errors get nothing. The request runs after this hook has
    // returned, so the session never waits for Clickback.
    if (e.agentId === undefined && e.reason === 'answer') {
      void serve($)
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await clearSeen($)

    return next(e)
  })

  // serve_ad has to be listed for $.mcp.call to reach it, so Claude gets its
  // name. Only the name: it waits behind tool search, and if Claude looks it up
  // it reads this line instead of the server's description.
  on('tool.describe', { tool: /__serve_ad$/ }, async ($, e, next) => {
    if (!isServeTool(e.tool, $.plugin.name)) {
      return next(e)
    }

    return { description: DESCRIPTION, isDeferred: true }
  })

  // Any call to serve_ad that isn't this mod's own is refused before it reaches
  // the server, so Claude (or a subagent) can't fetch an ad or read one. If this
  // hook ever fails, the call is refused too.
  on('tool.call', { tool: /__serve_ad$/ }, async ($, e, next) => {
    if (isServeTool(e.tool, $.plugin.name) && next.origin.plugin !== $.plugin.name) {
      return { deny: REFUSAL }
    }

    return next(e)
  }).catch(async () => ({ deny: REFUSAL }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Read first, so the band redraws when an ad or a sign-in line arrives or goes.
    const { value: ad } = await $.state.get(AD)
    const { value: signIn } = await $.state.get(SIGN_IN)

    if ((!ad && !signIn) || e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) {
      return next(e)
    }

    const { Box, Text, Link } = $.ui.resolve(e)

    const children = ad
      ? [`${LABEL} · ${ad.advertiser}: ${ad.headline} → `, ad.isLinkable ? Link({ href: ad.url, children: ad.host }) : `${ad.host} · ${ad.url}`]
      : signInLine(signIn ?? '', e.surface)

    return Box({
      flexDirection: 'column',
      children: [
        Box({
          paddingX: 1,
          children: Text({ dimColor: true, wrap: 'truncate-end', children }),
        }),
        await next(e),
      ],
    })
  })
}

/**
 * What the band says while the server needs a sign-in. /mcp is the terminal's
 * panel; the Desktop app doesn't have it, so there it's the CLI command.
 */
export function signInLine(server: string, surface: string): string {
  const how = surface === 'desktop'
    ? `run claude mcp login ${server} in a terminal`
    : `run /mcp, pick ${server} and choose Authenticate`

  return `Clickback · Connect Clickback to start earning: ${how}`
}

/**
 * Asks Clickback for an ad through the signed-in MCP server and keeps it for
 * the band, or notes that the server needs a sign-in. Never throws.
 */
export async function serve($: EngineInterface): Promise<void> {
  if (isServing) {
    return
  }

  isServing = true

  try {
    // Only where someone will see it: a terminal or the desktop app, the two
    // surfaces that draw AbovePrompt. Empty under `claude -p` and the SDK.
    const agent = agentFor(await $.session.surfaces())

    if (agent === undefined) {
      return
    }

    // An ad is still up, or one landed after the last prompt went in and hasn't
    // been on screen yet. Show that one instead of paying for another.
    const { value: held } = await $.state.get(AD)

    if (held) {
      return
    }

    // Once a minute at most, counting every session on this computer.
    const now = await $.clock.now()

    if (!(await isDue($, now))) {
      debug($, 'asked less than a minute ago, so not asking now')

      return
    }

    const server = await connected($)

    if (server === undefined) {
      return
    }

    // Claim the minute before asking, so another session finishing now waits.
    // Two that read the store at the same moment can both ask; the server
    // answers the second with nothing.
    await $.store.set(LAST_ASKED, now)

    const result = await within(
      $,
      TIMEOUT_MS,
      $.mcp.call(server, SERVE_TOOL, {
        surface: SURFACE,
        agent,
        session_id: await $.session.id(),
      }),
    )

    if (result === undefined) {
      debug($, 'serve_ad failed or answered nothing in time')

      return
    }

    if (result.isError) {
      debug($, `serve_ad failed: ${clean(textOf(result), 200)}`)

      return
    }

    const ad = adOf(result)

    if (ad === undefined) {
      debug($, 'no ad this time')

      return
    }

    const { value: prompts = 0 } = await $.state.get(PROMPTS)

    await $.state.set(AD, { ...ad, prompt: prompts })
    debug($, `showing an ad from ${ad.host}`)
  } catch (error) {
    debug($, `serve failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    isServing = false
  }
}

/**
 * Whether a minute has passed since any session on this computer last asked.
 * A time in the future (a clock that moved back) doesn't block forever.
 */
async function isDue($: EngineInterface, now: number): Promise<boolean> {
  const last = Number(await $.store.get(LAST_ASKED))

  if (!Number.isFinite(last) || last > now) {
    return true
  }

  return now - last >= INTERVAL_MS
}

/**
 * Notes whether the server needs a sign-in, where someone would see it. Never throws.
 */
async function check($: EngineInterface): Promise<void> {
  try {
    if (agentFor(await $.session.surfaces()) !== undefined) {
      await connected($)
    }
  } catch (error) {
    debug($, `sign-in check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The name to call our server by once it's connected, or undefined. When it
 * needs a sign-in, the band says how; when it connects, that line goes.
 */
async function connected($: EngineInterface): Promise<string | undefined> {
  const connection = await within($, TIMEOUT_MS, $.mcp.connect(SERVER))

  if (connection === undefined) {
    debug($, 'the Clickback server did not connect in time')

    return undefined
  }

  const { value: signIn } = await $.state.get(SIGN_IN)

  if (connection.isConnected) {
    connectedAs = connection.server

    if (signIn) {
      await $.state.set(SIGN_IN, null)
    }

    return connection.server
  }

  debug($, `the Clickback server is not connected: ${connection.reason}`)

  // Only a missing sign-in is something to tell the person about. A server they
  // turned off, or one that's down, shows nothing.
  if (connection.reason === 'auth') {
    const server = `plugin:${$.plugin.name}:${SERVER}`

    if (signIn !== server) {
      await $.state.set(SIGN_IN, server)
    }
  }

  return undefined
}

/**
 * Whether a tool call is to our serve_ad, under the name Claude Code gives a
 * plugin's server or the one the session connected it under.
 */
export function isServeTool(tool: string, plugin: string): boolean {
  return [`plugin:${plugin}:${SERVER}`, connectedAs]
    .filter((server): server is string => server !== undefined)
    .some(server => tool === toolName(server))
}

/**
 * What Claude Code calls a server's tool: `mcp__<server>__<tool>`, with
 * anything but letters, digits, `_` and `-` in the server's name made `_`.
 */
export function toolName(server: string, tool = SERVE_TOOL): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`
}

/**
 * A line in the debug log (`claude --debug`), never the transcript.
 */
function debug($: EngineInterface, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // Never in the way.
  }
}

/**
 * Takes the ad and the sign-in line down when the next prompt goes in, unless
 * the ad arrived after the last prompt, in which case it waits for the end of
 * that turn. The sign-in line comes back after the turn if it still applies.
 */
async function clearSeen($: EngineInterface): Promise<void> {
  try {
    const { value: prompts = 0 } = await $.state.get(PROMPTS)
    const { value: ad } = await $.state.get(AD)
    const { value: signIn } = await $.state.get(SIGN_IN)

    if (ad && ad.prompt <= prompts) {
      await $.state.set(AD, null)
    }

    if (signIn) {
      await $.state.set(SIGN_IN, null)
    }

    await $.state.set(PROMPTS, prompts + 1)
  } catch {
    // Never in the way.
  }
}

/**
 * What to report as the agent, or undefined where the band isn't drawn.
 */
export function agentFor(surfaces: readonly RenderSurface[]): string | undefined {
  if (surfaces.includes('desktop')) {
    return 'claude-code-desktop'
  }

  if (surfaces.includes('terminal')) {
    return 'claude-code'
  }

  return undefined
}

/**
 * The parts of a serve_ad result the band needs, cleaned up, or undefined when
 * there's no whole ad in it. The tool answers `{"ad": {...}}`, or `{"ad": null}`
 * when there's nothing to show. Claude Code hands a mod the result the way a
 * model would get it, with the structured content as JSON text, so this reads
 * either.
 */
export function adOf(result: McpToolResult): Served | undefined {
  let data: unknown = result.structuredContent

  if (recordOf(data) === undefined) {
    try {
      data = JSON.parse(textOf(result))
    } catch {
      return undefined
    }
  }

  const fields = recordOf(recordOf(data)?.ad)

  if (fields === undefined) {
    return undefined
  }

  const advertiser = clean(fields.advertiser, 60)
  const headline = clean(fields.headline, 140)
  const host = clean(fields.destination_host, 100)
  const url = urlOf(fields.tracking_url)

  if (advertiser === '' || headline === '' || host === '' || url === undefined) {
    return undefined
  }

  return { advertiser, headline, host, url: url.href, isLinkable: isLinkable(url) }
}

/**
 * The text of a tool result's first text block.
 */
function textOf(result: McpToolResult): string {
  const block = result.content.find(content => content.type === 'text' && typeof content.text === 'string')

  return block?.text ?? ''
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * One line of plain text: no control or bidi characters, single spaces, at
 * most `max` characters.
 */
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return ''
  }

  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function urlOf(value: unknown): URL | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  try {
    const url = new URL(value)

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined
    }

    if (url.username !== '' || url.password !== '') {
      return undefined
    }

    return url
  } catch {
    return undefined
  }
}

/**
 * Whether a `Link` will take it: https (or http://localhost), printable ASCII,
 * at most 2048 characters. Anything else would refuse the whole band, so it is
 * drawn as text instead (a local http://clickback.test server, say).
 */
function isLinkable(url: URL): boolean {
  const isAllowedScheme = url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')

  return isAllowedScheme && url.href.length <= 2048 && /^[\x21-\x7e]+$/.test(url.href)
}

/**
 * The answer, or undefined once `ms` has passed or the request failed.
 */
function within<T>($: EngineInterface, ms: number, request: Promise<T>): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve(undefined))

    request.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      () => {
        timer.cancel()
        resolve(undefined)
      },
    )
  })
}
