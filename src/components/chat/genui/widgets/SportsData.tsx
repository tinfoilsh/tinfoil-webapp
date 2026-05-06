import { Card } from '@/components/ui/card'
import { z } from 'zod'
import { defineGenUIWidget } from '../types'

const teamSchema = z.object({
  name: z.string(),
  score: z.union([z.string(), z.number()]).optional(),
  logo: z.string().optional(),
  rank: z.string().optional(),
})

const standingSchema = z.object({
  team: z.string(),
  wins: z.number().optional(),
  losses: z.number().optional(),
  ties: z.number().optional(),
  points: z.union([z.string(), z.number()]).optional(),
  gamesBack: z.string().optional(),
})

const schema = z.object({
  sport: z.string().optional().describe('e.g. "NBA", "Premier League"'),
  kind: z
    .enum(['fixture', 'standings'])
    .describe(
      '`fixture` for a single game (scoreline), `standings` for a league table',
    ),
  title: z.string().optional(),
  status: z
    .string()
    .optional()
    .describe('e.g. "Final", "Live — 3rd quarter", "Scheduled"'),
  venue: z.string().optional(),
  startTime: z.string().optional(),
  home: teamSchema.optional(),
  away: teamSchema.optional(),
  standings: z.array(standingSchema).optional(),
})

type Props = z.infer<typeof schema>

function isLiveStatus(status?: string): boolean {
  if (!status) return false
  const lowered = status.toLowerCase()
  return (
    lowered.includes('live') ||
    lowered.includes('in progress') ||
    lowered.includes('halftime') ||
    lowered.includes('half time') ||
    /\bot\b/.test(lowered)
  )
}

function numericScore(value?: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

const SPORTS_ACCENT_TEXT = 'text-blue-500 dark:text-blue-400'
const SPORTS_LEADER_CHIP = 'bg-blue-500 text-white'
const SPORTS_LEADER_ROW = 'bg-blue-500/10 dark:bg-blue-400/10'

function StatusPill({ status, live }: { status: string; live: boolean }) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-500 dark:text-red-400">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500 dark:bg-red-400" />
        {status}
      </span>
    )
  }
  return (
    <span className="text-xs font-medium text-content-muted">{status}</span>
  )
}

function TeamBlock({
  team,
  align,
  emphasis,
  live,
}: {
  team: NonNullable<Props['home']>
  align: 'left' | 'right'
  emphasis: 'win' | 'loss' | 'neutral'
  live: boolean
}) {
  const scoreColor = live
    ? 'text-red-500 dark:text-red-400'
    : emphasis === 'win'
      ? SPORTS_ACCENT_TEXT
      : emphasis === 'loss'
        ? 'text-content-muted'
        : 'text-content-primary'
  const scoreWeight = emphasis === 'win' ? 'font-bold' : 'font-semibold'

  return (
    <div
      className={`flex flex-1 flex-col gap-2 ${align === 'right' ? 'items-end' : 'items-start'}`}
    >
      <div
        className={`flex items-center gap-2 ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {team.logo && (
          <img
            src={team.logo}
            alt=""
            className="h-7 w-7 rounded-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        )}
        <div
          className={`flex flex-col ${align === 'right' ? 'items-end' : 'items-start'}`}
        >
          <span className="text-sm font-semibold text-content-primary">
            {team.name}
          </span>
          {team.rank && (
            <span className="text-[11px] text-content-muted">{team.rank}</span>
          )}
        </div>
      </div>
      <span
        className={`font-rounded text-[34px] tabular-nums leading-none ${scoreWeight} ${scoreColor}`}
        style={{
          fontFeatureSettings: '"tnum"',
          fontFamily:
            'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif',
        }}
      >
        {team.score !== undefined ? String(team.score) : '—'}
      </span>
    </div>
  )
}

function recordLabel(row: z.infer<typeof standingSchema>): string {
  const parts: string[] = []
  if (row.wins !== undefined) parts.push(String(row.wins))
  if (row.losses !== undefined) parts.push(String(row.losses))
  if (row.ties !== undefined && row.ties > 0) parts.push(String(row.ties))
  return parts.join('–')
}

function StandingsList({
  standings,
}: {
  standings: z.infer<typeof standingSchema>[]
}) {
  const showGamesBack = standings.some(
    (row) => row.gamesBack && row.gamesBack.length > 0,
  )

  return (
    <div className="overflow-hidden rounded-md border border-border-subtle">
      <ul className="flex flex-col">
        {standings.map((row, i) => {
          const leader = i === 0
          const record = recordLabel(row)
          return (
            <li
              key={`${row.team}-${i}`}
              className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? 'border-t border-border-subtle/60' : ''} ${leader ? SPORTS_LEADER_ROW : ''}`}
            >
              <span
                className={`inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
                  leader
                    ? SPORTS_LEADER_CHIP
                    : 'bg-content-primary/[0.05] text-content-muted'
                }`}
              >
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span
                  className={`truncate text-sm ${leader ? 'font-semibold text-content-primary' : 'font-medium text-content-primary'}`}
                >
                  {row.team}
                </span>
                {record && (
                  <span className="text-[11px] tabular-nums text-content-muted">
                    {record}
                  </span>
                )}
              </div>
              {showGamesBack && row.gamesBack && (
                <span className="text-[11px] tabular-nums text-content-muted">
                  {row.gamesBack}
                </span>
              )}
              {row.points !== undefined && (
                <span
                  className={`text-base font-semibold tabular-nums ${leader ? SPORTS_ACCENT_TEXT : 'text-content-primary'}`}
                  style={{
                    fontFamily:
                      'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif',
                  }}
                >
                  {String(row.points)}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function FixtureView({
  home,
  away,
  startTime,
  live,
}: {
  home?: Props['home']
  away?: Props['away']
  startTime?: string
  live: boolean
}) {
  const homeScore = numericScore(home?.score)
  const awayScore = numericScore(away?.score)
  const settled = !live && homeScore !== null && awayScore !== null
  const homeEmphasis: 'win' | 'loss' | 'neutral' = settled
    ? homeScore! > awayScore!
      ? 'win'
      : homeScore! < awayScore!
        ? 'loss'
        : 'neutral'
    : 'neutral'
  const awayEmphasis: 'win' | 'loss' | 'neutral' = settled
    ? awayScore! > homeScore!
      ? 'win'
      : awayScore! < homeScore!
        ? 'loss'
        : 'neutral'
    : 'neutral'

  const showStartTime =
    homeScore === null &&
    awayScore === null &&
    startTime &&
    startTime.length > 0

  return (
    <div className="flex items-center gap-4">
      {home && (
        <TeamBlock
          team={home}
          align="left"
          emphasis={homeEmphasis}
          live={live}
        />
      )}
      <span className="text-xs text-content-muted">
        {showStartTime ? startTime : '–'}
      </span>
      {away && (
        <TeamBlock
          team={away}
          align="right"
          emphasis={awayEmphasis}
          live={live}
        />
      )}
    </div>
  )
}

export const widget = defineGenUIWidget({
  name: 'render_sports_data',
  description:
    'Display a sports fixture (game scoreline) or a league standings table. Use when the user asks about a game score, match result, or league table.',
  schema,
  promptHint: 'a sports fixture scoreline or a league standings table',
  render: ({
    sport,
    kind,
    title,
    status,
    venue,
    startTime,
    home,
    away,
    standings,
  }) => {
    const live = isLiveStatus(status)

    return (
      <Card className="my-3 w-full overflow-hidden">
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-2">
            {sport && (
              <span className="text-[11px] font-semibold uppercase tracking-wider text-content-muted">
                {sport}
              </span>
            )}
            {status && <StatusPill status={status} live={live} />}
          </div>

          {kind === 'fixture' && (home || away) && (
            <FixtureView
              home={home}
              away={away}
              startTime={startTime}
              live={live}
            />
          )}

          {kind === 'standings' && standings && standings.length > 0 && (
            <StandingsList standings={standings} />
          )}

          {(title || venue || startTime) && (
            <div className="flex flex-col gap-0.5">
              {title && (
                <p className="text-xs font-medium text-content-primary">
                  {title}
                </p>
              )}
              {(venue || startTime) && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-content-muted">
                  {venue && <span>{venue}</span>}
                  {venue && startTime && <span>·</span>}
                  {startTime && <span>{startTime}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    )
  },
})
