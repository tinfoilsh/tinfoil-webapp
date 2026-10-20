// Generated from the harness's widgets.json by `npm run generate:widgets`.
// Do not edit.

export interface RenderStatCardsArgs {
  /**
   * Metrics or KPIs to display in a responsive grid
   *
   * @minItems 1
   */
  stats: {
    label: string
    value: string | number
    trend?: 'up' | 'down'
  }[]
}

export interface RenderTimelineArgs {
  /**
   * Chronological events
   *
   * @minItems 1
   */
  events: {
    date: string
    title: string
    description?: string
  }[]
  title?: string
}

export interface RenderChartArgs {
  /**
   * Chart type. "bar" for categorical comparisons, "line" for trends or sequences, "pie" for parts of a whole.
   */
  type: 'bar' | 'line' | 'pie'
  /**
   * Data points sharing the same keys — e.g. [{"label":"A","value":10}, ...]
   *
   * @minItems 1
   */
  data: {
    [k: string]: string | number
  }[]
  /**
   * For bar/line: key for the category axis. For pie: key for slice names. Defaults to the first string field.
   */
  xKey?: string
  /**
   * For bar/line: key for the numeric axis. For pie: key for slice values. Defaults to the first numeric field.
   */
  yKey?: string
  title?: string
  /**
   * Primary series color for bar/line charts. Pie slices use a built-in palette.
   */
  color?: string
}

export interface RenderImageArgs {
  /**
   * One or more images. A single image renders large with an optional caption; multiple images render in a responsive grid.
   *
   * @minItems 1
   */
  images: {
    /**
     * Image URL
     */
    url: string
    /**
     * Accessible alt text
     */
    alt?: string
    caption?: string
    /**
     * Optional destination when clicked
     */
    link?: string
  }[]
  title?: string
  /**
   * Single-image only. Container shape: square (1:1), video (16:9), or auto. Ignored when multiple images are provided.
   */
  aspectRatio?: 'square' | 'video' | 'auto'
}

export interface RenderLinkPreviewArgs {
  /**
   * Full URL of the resource
   */
  url: string
  /**
   * Best guess at the page or resource title. Used as a fallback if the metadata fetch fails.
   */
  title: string
}

export interface RenderArtifactPreviewArgs {
  title?: string
  description?: string
  /**
   * The artifact payload. Pick the `type` that matches your content: `url` for a live site, `html` for a self-contained page, or `markdown` for rich text. For SVG illustrations and Mermaid diagrams, emit a fenced ```svg or ```mermaid code block in the regular assistant message instead — the renderer shows the source and a live preview side-by-side automatically.
   */
  source:
    | {
        type: 'url'
        /**
         * Absolute URL rendered inside a sandboxed iframe
         */
        url: string
      }
    | {
        type: 'html'
        /**
         * Raw HTML rendered in a sandboxed iframe. Use exactly {"type":"html","html":"..."}.
         */
        html: string
      }
    | {
        type: 'markdown'
        /**
         * Markdown source. Use exactly {"type":"markdown","markdown":"..."}.
         */
        markdown: string
      }
  /**
   * Optional small footnote text
   */
  footer?: string
}

/**
 * Display either a live analog clock or an interactive countdown timer.
 */
export interface RenderClockArgs {
  /**
   * What to display. "clock" shows the current time as an analog face. "timer" counts down from a duration or to a target time. Defaults to "clock".
   */
  mode?: 'clock' | 'timer'
  /**
   * Short label, e.g. "New York" for a clock or "Tea" for a timer.
   */
  label?: string
  /**
   * Main title (timer mode)
   */
  title?: string
  /**
   * Optional description
   */
  description?: string
  /**
   * Clock mode only. IANA time zone, e.g. "America/New_York". Defaults to local.
   */
  timeZone?: string
  /**
   * Clock mode: include the second hand (default true).
   */
  showSeconds?: boolean
  /**
   * Clock mode: include date line (default true).
   */
  showDate?: boolean
  /**
   * Timer mode. Duration in seconds. Prefer this for requests like "set a 5 minute timer".
   */
  durationSeconds?: number
  /**
   * Timer mode. ISO date-time when the timer should end, e.g. "2026-12-31T23:59:59Z". Use when an exact end time is known.
   */
  target?: string
  /**
   * Timer mode. Message shown when the timer finishes.
   */
  completedMessage?: string
  /**
   * Timer mode. Alarm behavior when done. "sound" beeps; "flash" stays silent and flashes visually. Defaults to sound.
   */
  alarmMode?: 'sound' | 'flash'
}

export interface RenderRecipeCardArgs {
  title: string
  description?: string
  image?: string
  cuisine?: string
  difficulty?: 'easy' | 'medium' | 'hard'
  servings?: string | number
  prepTime?: string
  cookTime?: string
  totalTime?: string
  ingredients?: {
    quantity?: string
    item: string
    note?: string
  }[]
  steps?: {
    title?: string
    content: string
  }[]
  sourceUrl?: string
  source?: string
}

export interface RenderMessageComposeArgs {
  /**
   * email (shows subject + "Open in Mail") or message (body only)
   */
  channel?: 'email' | 'message'
  /**
   * Recipient — used for mailto:
   */
  to?: string
  /**
   * Card title, e.g. "Draft reply to Alice"
   */
  title?: string
  /**
   * One or more message drafts to offer. First variant is selected by default.
   *
   * @minItems 1
   */
  variants: {
    /**
     * Short variant label, e.g. "Formal", "Concise", "Apologetic"
     */
    label: string
    subject?: string
    body: string
  }[]
}

export interface RenderSportsDataArgs {
  /**
   * e.g. "NBA", "Premier League"
   */
  sport?: string
  /**
   * `fixture` for a single game (scoreline), `standings` for a league table
   */
  kind: 'fixture' | 'standings'
  title?: string
  /**
   * e.g. "Final", "Live — 3rd quarter", "Scheduled"
   */
  status?: string
  venue?: string
  startTime?: string
  home?: {
    name: string
    score?: string | number
    logo?: string
    rank?: string
  }
  away?: {
    name: string
    score?: string | number
    logo?: string
    rank?: string
  }
  standings?: {
    team: string
    wins?: number
    losses?: number
    ties?: number
    points?: string | number
    gamesBack?: string
  }[]
}

export interface RenderMapArgs {
  title?: string
  /**
   * `place` (default) for a single location, `search` for a POI query, `directions` for a routed list
   */
  mode?: 'place' | 'search' | 'directions'
  /**
   * Used when `mode === "search"`, e.g. "coffee"
   */
  query?: string
  /**
   * @minItems 1
   */
  locations: {
    /**
     * Display name shown on the pin
     */
    name: string
    /**
     * Full address or place query (e.g. "1 Apple Park Way, Cupertino, CA" or "Eiffel Tower, Paris"). Used for geocoding when coordinates are not provided.
     */
    address?: string
    /**
     * Latitude in degrees. Always provide this when you know it — relying on geocoding alone can fail for ambiguous names.
     */
    latitude?: number
    /**
     * Longitude in degrees. Always provide this when you know it — relying on geocoding alone can fail for ambiguous names.
     */
    longitude?: number
    /**
     * One-line subtitle
     */
    description?: string
  }[]
  travelMode?: 'driving' | 'walking' | 'transit' | 'cycling'
  /**
   * Visual style of the map tiles
   */
  mapType?: 'standard' | 'hybrid' | 'satellite' | 'muted'
}

// The arguments of each widget, by its tool name.
export interface WidgetArgs {
  render_stat_cards: RenderStatCardsArgs
  render_timeline: RenderTimelineArgs
  render_chart: RenderChartArgs
  render_image: RenderImageArgs
  render_link_preview: RenderLinkPreviewArgs
  render_artifact_preview: RenderArtifactPreviewArgs
  render_clock: RenderClockArgs
  render_recipe_card: RenderRecipeCardArgs
  render_message_compose: RenderMessageComposeArgs
  render_sports_data: RenderSportsDataArgs
  render_map: RenderMapArgs
}
