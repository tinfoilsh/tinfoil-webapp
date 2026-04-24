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

function TeamBlock({
  team,
  align,
}: {
  team: NonNullable<Props['home']>
  align: 'left' | 'right'
}) {
  return (
    <div
      className={`flex flex-1 flex-col items-${align === 'left' ? 'start' : 'end'} gap-1`}
    >
      <div
        className={`flex items-center gap-2 ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {team.logo && (
          <img
            src={team.logo}
            alt=""
            className="h-8 w-8 rounded-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        )}
        <span className="text-sm font-semibold text-content-primary">
          {team.name}
        </span>
      </div>
      {team.rank && (
        <span className="text-xs text-content-muted">{team.rank}</span>
      )}
      <span className="font-mono text-3xl font-semibold tabular-nums text-content-primary">
        {team.score !== undefined ? String(team.score) : '—'}
      </span>
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
  }) => (
    <Card className="my-3 max-w-xl overflow-hidden">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 text-xs text-content-muted">
            {sport && <span className="uppercase tracking-wide">{sport}</span>}
            {sport && status && <span>·</span>}
            {status && <span>{status}</span>}
          </div>
          {title && (
            <p className="text-sm font-semibold text-content-primary">
              {title}
            </p>
          )}
        </div>

        {kind === 'fixture' && (home || away) && (
          <div className="flex items-center gap-4">
            {home && <TeamBlock team={home} align="left" />}
            <span className="text-xs uppercase tracking-wide text-content-muted">
              vs
            </span>
            {away && <TeamBlock team={away} align="right" />}
          </div>
        )}

        {kind === 'standings' && standings && standings.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-content-muted">
                  <th className="py-1.5 pr-3 font-medium">Team</th>
                  <th className="py-1.5 pr-3 font-medium">W</th>
                  <th className="py-1.5 pr-3 font-medium">L</th>
                  <th className="py-1.5 pr-3 font-medium">T</th>
                  <th className="py-1.5 pr-3 font-medium">Pts</th>
                  <th className="py-1.5 pr-3 font-medium">GB</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((row, i) => (
                  <tr
                    key={`${row.team}-${i}`}
                    className="border-b border-border-subtle/50 last:border-0"
                  >
                    <td className="py-1.5 pr-3 font-medium text-content-primary">
                      {row.team}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-content-primary">
                      {row.wins ?? ''}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-content-primary">
                      {row.losses ?? ''}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-content-primary">
                      {row.ties ?? ''}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-content-primary">
                      {row.points !== undefined ? String(row.points) : ''}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-content-muted">
                      {row.gamesBack ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(venue || startTime) && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-content-muted">
            {venue && <span>{venue}</span>}
            {venue && startTime && <span>·</span>}
            {startTime && <span>{startTime}</span>}
          </div>
        )}
      </div>
    </Card>
  ),
})
