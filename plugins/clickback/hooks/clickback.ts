// Clickback mod: shows you one sponsored line above the prompt after Claude
// finishes a turn, and pays you for it.
//
// Display only. The ad is drawn in the AbovePrompt band and kept in $.state.
// It never goes to the model: this module adds no prompt context, rewrites no
// message and touches no tool call.
//
// Linking: the mod fetches ads over plain HTTP ($.http.fetch) with an ad token
// of its own, kept in $.store. It isn't a tool call, so no permission mode
// stops it. Until this computer has a token, the band shows a link and a code
// to approve in the browser, and the mod polls until the person does. The
// pending link sits in $.store too, so every session shows the same code, and
// the sessions take turns polling it.
//
// Paying: the server only charges for an ad, and credits you, once the mod
// says it drew it. The first time the band actually draws an ad, the mod
// confirms it with one request to the ad's shown_url.
//
// It asks at most once a minute, across the Claude Code sessions that share
// this plugin's $.store (the time of the last ask is kept there). Terminal
// sessions share one store; the Desktop app loads the plugin its own way and
// keeps another. A turn that ends sooner shows nothing new.
//
// Privacy: it sends Clickback the session id, surface=mod and which app you
// are in. Your prompts, Claude's replies, the transcript and your working
// directory never leave this machine.
//
// It never gets in the way: requests run on timers after the turn has
// finished, give up after a few seconds, and any failure (no ad, a slow or
// broken server, an answer it doesn't understand) shows no ad. The reason goes
// to the debug log (`claude --debug`), never the transcript.

import type { EngineInterface, On, PluginOptions, RenderSurface, Timer } from 'claude-code'

import type { ClickbackAd, ClickbackLink } from '../types'

/** The ad on screen, held by the host so a hot reload keeps it. */
const AD = { plugin: 'clickback', key: 'ad' } as const

/** How many prompts this session has submitted so far. */
const PROMPTS = { plugin: 'clickback', key: 'prompts' } as const

/** The line asking the person to connect this computer, while a link is pending. */
const LINK = { plugin: 'clickback', key: 'link' } as const

export const LABEL = 'Sponsored'
export const CONNECT = 'Clickback · Connect this computer to start earning:'
export const SURFACE = 'mod'
export const TIMEOUT_MS = 3000

/** At most one ad request this often, from every session on the computer. */
export const INTERVAL_MS = 60_000

/**
 * The longest `Link` href, percent-encoded. A longer one keeps the whole band
 * from drawing, so an ad or approval page with one isn't shown.
 */
export const MAX_HREF = 2048

/** How many times a draw may try to confirm one ad. */
export const CONFIRM_TRIES = 3

/** The $.store key holding when any session last asked, in epoch milliseconds. */
export const LAST_ASKED = 'lastAskedAt'

/** The $.store key holding the ad token. */
export const TOKEN = 'token'

/** The $.store key holding the link waiting for approval, a PendingLink. */
export const PENDING_LINK = 'link'

/**
 * The $.store key holding when any session last polled the pending link, as
 * `{ deviceCode, at }` (epoch milliseconds), so open sessions take turns.
 */
export const LINK_POLLED = 'linkPolledAt'

/**
 * A poll goes out once the last one, from any session, is at least the
 * link's interval less this old, so one session always gets through each
 * interval though their timers drift.
 */
export const POLL_SLACK_MS = 1000

/** A link waiting for the person to approve it, as kept in $.store. */
export type PendingLink = {
  deviceCode: string
  userCode: string
  /** verification_uri, shown in the connect line. */
  uri: string
  /** verification_uri_complete, which the link opens. */
  url: string
  /** When it stops working, in epoch milliseconds. */
  expiresAt: number
  /** How often to poll, in seconds. */
  interval: number
}

type Served = Omit<ClickbackAd, 'prompt'>

type Answer = { status: number; data: Record<string, unknown> | undefined }

/** Where Clickback lives, from the `base_url` option, with no trailing slash. */
let baseUrl = 'https://clickback.dev'

/** Only one serve request at a time. A reload resets it, which is harmless. */
let isServing = false

/** Only one link started at a time. */
let isLinking = false

/** The timer polling the pending link. A reload stops it, and session.start starts another. */
let polling: Timer | undefined

/** Only one poll at a time. */
let isPolling = false

/**
 * Each drawn ad's confirmation in this module instance, by shown_url: being
 * sent, done, or how many tries have failed.
 */
const confirmations = new Map<string, 'sending' | 'done' | number>()

export function register(on: On, options: PluginOptions) {
  baseUrl = typeof options.base_url === 'string' ? options.base_url.replace(/\/+$/, '') : baseUrl

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    // Ask to connect straight away, not only after a turn, or pick up a link
    // another session started. On a timer, where work that outlives an event
    // belongs.
    $.clock.after(0, () => void start($))

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Main-loop turns that finished normally. Subagents, interrupts, refusals
    // and API errors get nothing. The request runs on a timer, after this hook
    // has returned, so the session never waits for Clickback.
    if (e.agentId === undefined && e.reason === 'answer') {
      $.clock.after(0, () => void serve($))
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await clearSeen($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Read first, so the band redraws when an ad or the connect line arrives or goes.
    const { value: ad } = await $.state.get(AD)
    const { value: link } = await $.state.get(LINK)

    if ((!ad && !link) || e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) {
      return next(e)
    }

    const { Box, Text, Link } = $.ui.resolve(e)

    // The whole line is one Link, so a click anywhere on it opens the ad (or
    // the approval page). Where a surface won't open the address (the Desktop
    // app takes https and http://localhost) it draws the text plain and the
    // rest of the band stands.
    let line: ReturnType<typeof Link> | undefined

    if (ad) {
      line = Link({ href: ad.url, children: `${LABEL} · ${ad.advertiser}: ${ad.headline} → ${ad.host}` })
    } else if (link) {
      line = Link({ href: link.url, children: `${CONNECT} ${link.label} (code ${link.code})` })
    }

    const tree = Box({
      flexDirection: 'column',
      children: [
        Box({
          paddingX: 1,
          // Wraps rather than cuts, so a long ad shows whole.
          children: Text({ dimColor: true, wrap: 'wrap', children: line }),
        }),
        await next(e),
      ],
    })

    if (ad) {
      drawn($, ad)
    }

    return tree
  })
}

/**
 * On session start: where the band draws and this computer isn't linked,
 * shows the connect line, reusing a link another session started. Never throws.
 */
async function start($: EngineInterface): Promise<void> {
  try {
    if (agentFor(await $.session.surfaces()) === undefined) {
      return
    }

    if ((await tokenOf($)) !== undefined) {
      // Linked, maybe by another session while this module reloaded.
      await clearLine($)

      return
    }

    await startLinking($)
  } catch (error) {
    debug($, `starting failed: ${messageOf(error)}`)
  }
}

/**
 * Asks Clickback for an ad with the ad token and keeps it for the band, or
 * starts linking when there's no token. Never throws.
 */
export async function serve($: EngineInterface): Promise<void> {
  if (isServing) {
    return
  }

  isServing = true

  try {
    // Only where someone will see it: a terminal or the desktop app, the two
    // surfaces that draw AbovePrompt. Empty under `claude -p` and the SDK.
    const surfaces = await $.session.surfaces()
    const agent = agentFor(surfaces)

    if (agent === undefined) {
      debug($, `nothing here draws the band (${surfaces.join(', ') || 'no surface'}), so not asking`)

      return
    }

    // An ad is still up, or one landed after the last prompt went in and hasn't
    // been on screen yet. Show that one instead of paying for another.
    const { value: held } = await $.state.get(AD)

    if (held) {
      debug($, 'the last ad has not been seen yet, so not asking')

      return
    }

    const token = await tokenOf($)

    if (token === undefined) {
      debug($, 'this computer is not linked yet, so not asking')
      await startLinking($)

      return
    }

    // Once a minute at most, counting every session on this computer.
    const now = await $.clock.now()

    if (!(await isDue($, now))) {
      debug($, 'asked less than a minute ago, so not asking now')

      return
    }

    // Claim the minute before asking, so another session finishing now waits.
    // Two that read the store at the same moment can both ask; the server
    // answers the second with nothing.
    await $.store.set(LAST_ASKED, now)

    debug($, 'asking for an ad')

    const answer = await send($, 'asking for an ad', `${baseUrl}/api/ads/serve`, {
      surface: SURFACE,
      agent,
      session_id: await $.session.id(),
    }, token)

    if (answer === undefined) {
      return
    }

    if (answer.status === 401) {
      debug($, 'the ad token was refused (HTTP 401), so linking again')
      await forget($, token)
      await startLinking($)

      return
    }

    if (answer.status !== 200) {
      debug($, `asking for an ad failed: HTTP ${answer.status}`)

      return
    }

    if (answer.data?.ad === null) {
      debug($, 'no ad this time')

      return
    }

    const ad = adOf(answer.data)

    if (ad === undefined) {
      debug($, 'the answer had no ad the band could show')

      return
    }

    const { value: prompts = 0 } = await $.state.get(PROMPTS)

    await $.state.set(AD, { ...ad, prompt: prompts })
    debug($, `got ad ${ad.impressionId} from ${ad.host}`)
  } catch (error) {
    debug($, `asking for an ad failed: ${messageOf(error)}`)
  } finally {
    isServing = false
  }
}

/**
 * Shows the connect line and polls until the link is approved, denied or
 * expired. Reuses the link in $.store until it expires, so every session
 * shows the same code; otherwise asks Clickback for a new one. Never throws.
 */
async function startLinking($: EngineInterface): Promise<void> {
  if (isLinking || polling !== undefined) {
    return
  }

  isLinking = true

  try {
    // Only where someone will see the code, and only while there's no token
    // (another session may have stored one after a 401 here).
    const agent = agentFor(await $.session.surfaces())

    if (agent === undefined || (await tokenOf($)) !== undefined) {
      return
    }

    const now = await $.clock.now()
    let pending = pendingOf(await $.store.get(PENDING_LINK))

    if (pending !== undefined && pending.expiresAt > now) {
      debug($, `using the link already started, code ${pending.userCode}`)
    } else {
      debug($, 'linking this computer to Clickback')

      const answer = await send($, 'starting a link', `${baseUrl}/api/link`, { agent })

      if (answer === undefined) {
        return
      }

      pending = answer.status === 201 ? linkOf(answer.data, now) : undefined

      if (pending === undefined) {
        debug($, answer.status === 201 ? 'starting a link failed: the answer was incomplete' : `starting a link failed: HTTP ${answer.status}`)

        return
      }

      await $.store.set(PENDING_LINK, pending)
    }

    await showLine($, pending)
    debug($, `showing the code ${pending.userCode}`)

    polling = $.clock.every(pending.interval * 1000, () => void poll($))
  } catch (error) {
    debug($, `starting a link failed: ${messageOf(error)}`)
  } finally {
    isLinking = false
  }
}

/**
 * One poll of the pending link: stores the token once it's approved, and
 * stops when it's denied or expired, or another session has linked. Never throws.
 */
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) {
    return
  }

  isPolling = true

  try {
    if ((await tokenOf($)) !== undefined) {
      debug($, 'another session linked this computer')
      await stopLinking($)

      return
    }

    const pending = pendingOf(await $.store.get(PENDING_LINK))

    if (pending === undefined) {
      // Another session dropped it. A later turn starts a new one.
      debug($, 'the link is gone, so not polling any more')
      await stopLinking($)

      return
    }

    const now = await $.clock.now()

    if (pending.expiresAt <= now) {
      debug($, `code ${pending.userCode} expired before it was approved`)
      await stopLinking($, pending)

      return
    }

    // Another session may have started a newer link: show its code.
    await showLine($, pending)

    // Every open session polls on its own timer, and the server limits polls
    // per IP address, so they take turns: skip this one if any session polled
    // this link less than an interval ago. Stamp before asking, so the next
    // session to tick sees it. Two that tick at the same moment can both ask.
    if (!(await isPollDue($, pending, now))) {
      return
    }

    await $.store.set(LINK_POLLED, { deviceCode: pending.deviceCode, at: now })

    const answer = await send($, 'checking the link', `${baseUrl}/api/link/token`, { device_code: pending.deviceCode })

    if (answer === undefined) {
      return
    }

    if (answer.status === 202) {
      debug($, `code ${pending.userCode} is still waiting to be approved`)

      return
    }

    if (answer.status === 200) {
      const token = answer.data?.token

      if (typeof token !== 'string' || token === '') {
        debug($, 'checking the link failed: the answer had no token')

        return
      }

      await $.store.set(TOKEN, token)
      await stopLinking($, pending)
      debug($, 'linked this computer')

      return
    }

    if (answer.status === 403) {
      debug($, `code ${pending.userCode} was denied`)
      await stopLinking($, pending)

      return
    }

    if (answer.status === 410) {
      // A link answers once. If another session got the token, this is it.
      if ((await tokenOf($)) !== undefined) {
        debug($, 'another session linked this computer')
        await stopLinking($)
      } else {
        debug($, `code ${pending.userCode} expired before it was approved`)
        await stopLinking($, pending)
      }

      return
    }

    debug($, `checking the link failed: HTTP ${answer.status}`)
  } catch (error) {
    debug($, `checking the link failed: ${messageOf(error)}`)
  } finally {
    isPolling = false
  }
}

/**
 * Stops polling and takes the connect line down. With `pending`, also drops
 * that link from $.store, unless another session has already replaced it.
 */
async function stopLinking($: EngineInterface, pending?: PendingLink): Promise<void> {
  polling?.cancel()
  polling = undefined

  if (pending !== undefined && pendingOf(await $.store.get(PENDING_LINK))?.deviceCode === pending.deviceCode) {
    await $.store.delete(PENDING_LINK)
    await $.store.delete(LINK_POLLED)
  }

  await clearLine($)
}

/**
 * Whether it's this session's turn to poll `pending`: no session has polled
 * it within its interval (less POLL_SLACK_MS). A stamp for another link, or
 * one in the future (a clock that moved back), doesn't hold it back.
 */
async function isPollDue($: EngineInterface, pending: PendingLink, now: number): Promise<boolean> {
  const polled = recordOf(await $.store.get(LINK_POLLED))
  const at = Number(polled?.at)

  if (polled?.deviceCode !== pending.deviceCode || !Number.isFinite(at) || at > now) {
    return true
  }

  return now - at >= pending.interval * 1000 - POLL_SLACK_MS
}

/**
 * Puts the connect line for `pending` in the band, unless it's already there.
 */
async function showLine($: EngineInterface, pending: PendingLink): Promise<void> {
  const url = urlOf(pending.url)

  if (url === undefined) {
    return
  }

  const line: ClickbackLink = { url: url.href, label: pending.uri, code: pending.userCode }
  const { value: shown } = await $.state.get(LINK)

  if (shown?.url !== line.url || shown.code !== line.code || shown.label !== line.label) {
    await $.state.set(LINK, line)
  }
}

async function clearLine($: EngineInterface): Promise<void> {
  const { value: shown } = await $.state.get(LINK)

  if (shown) {
    await $.state.set(LINK, null)
  }
}

/**
 * Called each time the band returns the ad's tree. The first time, confirms
 * the ad was drawn. A render hook may not write $.state, and shouldn't wait
 * on the network, so the request runs on a timer. A failed confirmation is
 * tried again on a later draw, CONFIRM_TRIES times at most.
 */
function drawn($: EngineInterface, ad: ClickbackAd): void {
  const tries = confirmations.get(ad.shownUrl) ?? 0

  if (typeof tries !== 'number' || tries >= CONFIRM_TRIES) {
    return
  }

  confirmations.set(ad.shownUrl, 'sending')

  try {
    $.clock.after(0, () => void confirm($, ad, tries))
  } catch (error) {
    confirmations.set(ad.shownUrl, tries)
    debug($, `confirming ad ${ad.impressionId} failed: ${messageOf(error)}`)
  }
}

/**
 * Tells Clickback the ad was drawn, which is what it charges and credits for.
 * Never throws.
 */
async function confirm($: EngineInterface, ad: ClickbackAd, tries: number): Promise<void> {
  let outcome: 'done' | number = tries + 1

  try {
    const token = await tokenOf($)

    if (token === undefined) {
      debug($, `confirming ad ${ad.impressionId} failed: this computer is not linked`)

      return
    }

    const answer = await send($, `confirming ad ${ad.impressionId}`, ad.shownUrl, {}, token)

    if (answer === undefined) {
      return
    }

    if (answer.status === 200) {
      outcome = 'done'
      debug($, `confirmed ad ${ad.impressionId} as shown, charged: ${answer.data?.charged === true ? 'yes' : 'no'}`)
    } else if (answer.status === 410) {
      outcome = 'done'
      debug($, `ad ${ad.impressionId} expired before it was confirmed (HTTP 410)`)
    } else if (answer.status === 404) {
      outcome = 'done'
      debug($, `Clickback doesn't know ad ${ad.impressionId} (HTTP 404)`)
    } else if (answer.status === 401) {
      outcome = 'done'
      debug($, 'the ad token was refused (HTTP 401), so linking again')
      await forget($, token)
      await startLinking($)
    } else {
      debug($, `confirming ad ${ad.impressionId} failed: HTTP ${answer.status}`)
    }
  } catch (error) {
    debug($, `confirming ad ${ad.impressionId} failed: ${messageOf(error)}`)
  } finally {
    confirmations.set(ad.shownUrl, outcome)
  }
}

/**
 * POSTs JSON to Clickback and reads the JSON answer, or logs why there is
 * none and resolves undefined. Gives up after TIMEOUT_MS; a late answer is
 * logged and ignored.
 */
async function send($: EngineInterface, what: string, url: string, body: Record<string, unknown>, token?: string): Promise<Answer | undefined> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }

  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`
  }

  const request = $.http.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const outcome = await within($, TIMEOUT_MS, request)

  if ('error' in outcome) {
    debug($, `${what} failed: ${outcome.error}`)

    if (outcome.isLate) {
      void late($, what, request)
    }

    return undefined
  }

  let data: unknown

  try {
    data = JSON.parse(outcome.value.text)
  } catch {
    data = undefined
  }

  return { status: outcome.value.status, data: recordOf(data) }
}

/**
 * Logs how a request the mod stopped waiting for ended. Never throws.
 */
async function late($: EngineInterface, what: string, request: Promise<{ status: number }>): Promise<void> {
  try {
    const response = await request

    debug($, `${what}: answered after the limit (HTTP ${response.status}), so it was ignored`)
  } catch (error) {
    debug($, `${what} failed: ${messageOf(error)}`)
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

async function tokenOf($: EngineInterface): Promise<string | undefined> {
  const token = await $.store.get(TOKEN)

  return typeof token === 'string' && token !== '' ? token : undefined
}

/**
 * Deletes a token the server refused, unless another session has already
 * stored a new one.
 */
async function forget($: EngineInterface, token: string): Promise<void> {
  if ((await $.store.get(TOKEN)) === token) {
    await $.store.delete(TOKEN)
  }
}

/**
 * A line in the debug log (`claude --debug`), led by the plugin's name. Never
 * the transcript: the mod adds nothing there.
 */
function debug($: EngineInterface, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // Never in the way.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Takes the ad down when the next prompt goes in, unless the ad arrived after
 * the last prompt, in which case it waits for the end of that turn.
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
 * The parts of a serve answer the band needs, cleaned up, or undefined when
 * there's no whole ad in it. The server answers `{"ad": {...}}`, or
 * `{"ad": null}` when there's nothing to show. The ad is confirmed with the
 * token at shown_url, so that has to be on the Clickback server itself.
 */
export function adOf(data: unknown, base = baseUrl): Served | undefined {
  const fields = recordOf(recordOf(data)?.ad)

  if (fields === undefined) {
    return undefined
  }

  const advertiser = clean(fields.advertiser, 60)
  const headline = clean(fields.headline, 140)
  const host = clean(fields.destination_host, 100)
  const url = urlOf(fields.tracking_url)
  const shownUrl = urlOf(fields.shown_url)
  const impressionId = typeof fields.impression_id === 'number' || typeof fields.impression_id === 'string'
    ? clean(String(fields.impression_id), 40)
    : ''

  if (advertiser === '' || headline === '' || host === '' || url === undefined || impressionId === '') {
    return undefined
  }

  if (shownUrl === undefined || shownUrl.origin !== urlOf(base)?.origin) {
    return undefined
  }

  return { advertiser, headline, host, url: url.href, impressionId, shownUrl: shownUrl.href }
}

/**
 * The link from a `POST /api/link` answer, or undefined when it isn't whole.
 */
function linkOf(data: unknown, now: number): PendingLink | undefined {
  const fields = recordOf(data)
  const expiresIn = Number(fields?.expires_in)
  const interval = Number(fields?.interval ?? 5)

  if (!(expiresIn > 0)) {
    return undefined
  }

  return pendingOf({
    deviceCode: fields?.device_code,
    userCode: clean(fields?.user_code, 20),
    uri: clean(fields?.verification_uri, 200),
    url: fields?.verification_uri_complete,
    expiresAt: now + expiresIn * 1000,
    interval: Number.isFinite(interval) ? Math.min(Math.max(interval, 1), 60) : 5,
  })
}

/**
 * A pending link as kept in $.store, or undefined when it isn't one.
 */
function pendingOf(value: unknown): PendingLink | undefined {
  const link = recordOf(value)

  if (
    link === undefined
    || typeof link.deviceCode !== 'string' || link.deviceCode === ''
    || typeof link.userCode !== 'string' || link.userCode === ''
    || typeof link.uri !== 'string' || link.uri === ''
    || urlOf(link.url) === undefined
    || typeof link.expiresAt !== 'number' || !Number.isFinite(link.expiresAt)
    || typeof link.interval !== 'number' || !(link.interval >= 1)
  ) {
    return undefined
  }

  return {
    deviceCode: link.deviceCode,
    userCode: link.userCode,
    uri: link.uri,
    url: String(link.url),
    expiresAt: link.expiresAt,
    interval: link.interval,
  }
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

/**
 * An http or https URL with no credentials, at most MAX_HREF characters once
 * percent-encoded, or undefined. Every URL the mod links to or sends to.
 */
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

    return url.href.length <= MAX_HREF ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * The answer, or why there is none: it failed, or `ms` passed first (`isLate`).
 */
function within<T>($: EngineInterface, ms: number, request: Promise<T>): Promise<{ value: T } | { error: string; isLate?: true }> {
  return new Promise(resolve => {
    const timer = $.clock.after(ms, () => resolve({ error: `no answer within ${ms}ms`, isLate: true }))

    request.then(
      value => {
        timer.cancel()
        resolve({ value })
      },
      error => {
        timer.cancel()
        resolve({ error: messageOf(error) })
      },
    )
  })
}
