/**
 * One served ad, as the mod keeps it for the session in `$.state` until the
 * person has had a chance to see it.
 */
export type ClickbackAd = {
  advertiser: string
  headline: string
  /** The advertiser's host, shown at the end of the line. */
  host: string
  /** The Clickback tracking URL the link opens, at most 2048 characters. */
  url: string
  /** How many prompts the session had submitted when the ad arrived. */
  prompt: number
  /** The impression's id on the server. */
  impressionId: string
  /** Where the mod confirms the ad was drawn, on the Clickback server. */
  shownUrl: string
}

/**
 * The line asking the person to connect this computer, while a link waits for
 * approval. The device code stays in `$.store`, which other plugins can't read.
 */
export type ClickbackLink = {
  /** verification_uri_complete: the approval page with the code filled in, which the link opens. */
  url: string
  /** verification_uri, shown in the line, so it can be typed with the code. */
  label: string
  /** The code the page shows, for the person to check, e.g. ABCD-EFGH. */
  code: string
}

declare module 'claude-code' {
  interface PluginState {
    clickback: {
      ad: ClickbackAd | null
      prompts: number
      link: ClickbackLink | null
    }
  }
}
