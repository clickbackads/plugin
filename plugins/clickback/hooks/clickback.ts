// Clickback mod: shows you one sponsored line above the prompt after Claude
// finishes a turn, and pays you for it.
//
// Display only. The ad is drawn in the AbovePrompt band and kept in $.state.
// It never goes to the model: this module adds no prompt context, rewrites no
// message and touches no tool call.
//
// Privacy: it sends Clickback your token, the session id, surface=mod and which
// app you are in. Your prompts, Claude's replies, the transcript and your
// working directory never leave this machine.
//
// It never gets in the way: the request runs after the turn has finished, gives
// up after a few seconds, and any failure (no token, no ad, a slow or broken
// server, a response it doesn't understand) shows nothing.

import type {
  EngineInterface,
  HttpResponse,
  On,
  PluginOptions,
  RenderSurface,
} from 'claude-code'

import type { ClickbackAd } from '../types'

/** The ad on screen, held by the host so a hot reload keeps it. */
const AD = { plugin: 'clickback', key: 'ad' } as const

/** How many prompts this session has submitted so far. */
const PROMPTS = { plugin: 'clickback', key: 'prompts' } as const

export const LABEL = 'Sponsored'
export const SURFACE = 'mod'
export const TIMEOUT_MS = 3000
export const DEFAULT_BASE_URL = 'https://clickback.dev'

export type Config = { token: string; base: string }

type Served = Omit<ClickbackAd, 'prompt'>

/** Only one serve request at a time. A reload resets it, which is harmless. */
let isServing = false

export function register(on: On, options: PluginOptions) {
  const config = configOf(options)

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Main-loop turns that finished normally, like the Stop hook. Subagents,
    // interrupts, refusals and API errors get nothing. The request runs after
    // this hook has returned, so the session never waits for Clickback.
    if (config !== undefined && e.agentId === undefined && e.reason === 'answer') {
      void serve($, config)
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await clearSeen($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Read first, so the band redraws when an ad arrives or is cleared.
    const { value: ad } = await $.state.get(AD)

    if (!ad || e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) {
      return next(e)
    }

    const { Box, Text, Link } = $.ui.resolve(e)
    const target = ad.isLinkable
      ? Link({ href: ad.url, children: ad.host })
      : `${ad.host} · ${ad.url}`

    return Box({
      flexDirection: 'column',
      children: [
        Box({
          paddingX: 1,
          children: Text({
            dimColor: true,
            wrap: 'truncate-end',
            children: [`${LABEL} · ${ad.advertiser}: ${ad.headline} → `, target],
          }),
        }),
        await next(e),
      ],
    })
  })
}

/**
 * Asks Clickback for an ad and keeps it for the band. Never throws.
 */
export async function serve($: EngineInterface, config: Config): Promise<void> {
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

    const response = await within(
      $,
      TIMEOUT_MS,
      $.http.fetch(`${config.base}/api/v1/ads/serve`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          surface: SURFACE,
          agent,
          session_id: await $.session.id(),
        }),
      }),
    )

    if (response?.status !== 200) {
      debug($, `serve answered ${response === undefined ? 'nothing in time' : response.status}`)

      return
    }

    const ad = adOf(response.text)

    if (ad === undefined) {
      debug($, 'serve answered with something that is not an ad')

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
 * Takes the ad down when the next prompt goes in, unless it arrived after the
 * last prompt, in which case it waits for the end of that turn.
 */
async function clearSeen($: EngineInterface): Promise<void> {
  try {
    const { value: prompts = 0 } = await $.state.get(PROMPTS)
    const { value: ad } = await $.state.get(AD)

    if (ad && ad.prompt <= prompts) {
      await $.state.set(AD, null)
    }

    await $.state.set(PROMPTS, prompts + 1)
  } catch {
    // Never in the way.
  }
}

/**
 * The token and server from the plugin's userConfig, or undefined when they
 * can't be ours.
 */
export function configOf(options: PluginOptions): Config | undefined {
  const token = typeof options.api_token === 'string' ? options.api_token.replace(/\s+/g, '') : ''
  const base = (typeof options.base_url === 'string' && options.base_url.trim() !== ''
    ? options.base_url.trim()
    : DEFAULT_BASE_URL
  ).replace(/\/+$/, '')

  // A Sanctum token is "<id>|<random>", maybe with a prefix.
  if (!/^[A-Za-z0-9._|-]+$/.test(token)) {
    return undefined
  }

  if (!/^https?:\/\/[^\s/?#]+[^\s?#]*$/.test(base)) {
    return undefined
  }

  return { token, base }
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
 * The parts of a serve response the band needs, cleaned up, or undefined when
 * the response isn't a whole ad.
 */
export function adOf(text: string): Served | undefined {
  let data: unknown

  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }

  // The serve endpoint wraps the ad in "data", as Laravel resources do.
  const fields = recordOf(recordOf(data)?.data)

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
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
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
 * The response, or undefined once `ms` has passed or the request failed.
 */
function within($: EngineInterface, ms: number, request: Promise<HttpResponse>): Promise<HttpResponse | undefined> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve(undefined))

    request.then(
      response => {
        timer.cancel()
        resolve(response)
      },
      () => {
        timer.cancel()
        resolve(undefined)
      },
    )
  })
}
