/**
 * One served ad, as the mod keeps it for the session in `$.state` until the
 * person has had a chance to see it.
 */
export type ClickbackAd = {
  advertiser: string
  headline: string
  /** The advertiser's host, shown as the link's text. */
  host: string
  /** The Clickback tracking URL the link opens. */
  url: string
  /** Whether `url` is one a `Link` accepts (https, or http://localhost). */
  isLinkable: boolean
  /** How many prompts the session had submitted when the ad arrived. */
  prompt: number
}

declare module 'claude-code' {
  interface PluginState {
    clickback: {
      ad: ClickbackAd | null
      prompts: number
      /** The MCP server to sign in to (`plugin:clickback:clickback`), while the band says so. */
      signIn: string | null
    }
  }
}
