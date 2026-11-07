import { ArtifactPreviewPanel } from '@/components/chat/genui/widgets/ArtifactPreview'
import { act, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PLAYBOOK_MARKDOWN, PLAYBOOK_TITLE } from './artifact-fixture'

function cellTexts(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .map((row) =>
      [
        ...within(row).queryAllByRole('columnheader'),
        ...within(row).queryAllByRole('cell'),
      ].map((cell) => cell.textContent ?? ''),
    )
}

describe('Markdown artifact preview', () => {
  it('renders tables, task lists, quotes and rules like a chat reply', async () => {
    await act(async () => {
      render(
        <ArtifactPreviewPanel
          title={PLAYBOOK_TITLE}
          source={{ type: 'markdown', markdown: PLAYBOOK_MARKDOWN }}
          layout="sidebar"
        />,
      )
    })
    const panel = screen.getByRole('tabpanel')

    const tables = within(panel).getAllByRole('table')
    expect(tables.map(cellTexts)).toEqual([
      [
        ['Flow', 'Amount', 'Who'],
        [
          'Rent to landlord (Zelle/wire, from tenant)',
          '$9,700/mo',
          'You, as tenant',
        ],
        [
          'Company reimbursement (documented business half)',
          '$4,850/mo',
          'Tinfoil → you (tax-free)',
        ],
        [
          'Your share (personal half, from existing salary)',
          '$4,850/mo',
          'You',
        ],
      ],
      [
        ['Date(s)', 'Person', 'Relationship', 'Overnight?', 'Business purpose'],
        [
          'Jul 8–10',
          'Jules D.',
          'Co-founder',
          'Yes (2 nights)',
          'Co-founder offsite + board meeting',
        ],
        [
          'Jul 14–19',
          '[Visiting engineer]',
          'Employee',
          'Yes (5 nights)',
          'Onboarding week',
        ],
        [
          'Jul 22',
          '[Name], [Name]',
          'Employees',
          'No',
          'Team dinner (9 people)',
        ],
        ['', '', '', '', ''],
      ],
      [
        ["❌ Don't", '✅ Instead'],
        [
          'Charge Tinfoil rent or a "venue fee" for the space',
          'Reimburse actual costs only (food, cleaning, supplies)',
        ],
        ['Reimburse a flat $5,000', 'Reimburse the documented half — $4,850'],
        [
          'Have Tinfoil pay the landlord directly',
          'Tenant pays landlord; company reimburses tenant',
        ],
        [
          'Bump salary to cover rent',
          'Keep salary unchanged; reimbursement is tax-free',
        ],
        [
          'Scale events beyond dinner-party size without asking',
          'Venue rental for the big stuff',
        ],
      ],
    ])
    expect(panel).not.toHaveTextContent('|---|')

    const tasks = within(panel).getAllByRole('checkbox')
    expect(
      tasks.map((task) => [
        (task as HTMLInputElement).checked,
        task.closest('li')?.textContent?.trim(),
      ]),
    ).toEqual([
      [
        false,
        'Adopt the expense policy (draft in §3) — board note or Notion page is fine',
      ],
      [
        false,
        'Send the landlord consent email (draft in §5) and save his reply',
      ],
      [false, 'Create the usage log (template in §4) — spreadsheet or doc'],
      [false, 'Have your CPA bless the ~50% split at your next tax filing'],
    ])
    expect(panel).not.toHaveTextContent('[ ]')

    const routine = within(panel)
      .getAllByRole('list')
      .find((list) => list.tagName === 'OL')!
    expect(
      within(routine)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Pay the full $9,700 to the landlord on the usual date',
      'Log guests/meetings as they happen (or reconstruct at month end)',
      "Submit one expense report: rent receipt + month's log + $4,850 claim",
      'Bookkeeper reimburses and codes it as lodging/travel — no payroll tax, no W-2 impact',
    ])

    expect(within(panel).getByRole('blockquote')).toHaveTextContent(
      /^Business expense reimbursement\. The Company reimburses/,
    )
    expect(within(panel).getAllByRole('separator')).toHaveLength(7)
  })
})
