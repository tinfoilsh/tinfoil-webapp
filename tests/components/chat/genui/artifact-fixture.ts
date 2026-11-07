// A Markdown artifact as a model wrote it: GFM tables (one ending in a row
// of empty cells), a task list, a quote, rules, and non-ASCII text.
export const PLAYBOOK_TITLE = 'Apartment Expense Structure — Setup Playbook'

export const PLAYBOOK_MARKDOWN = `# Apartment Expense Structure — Setup Playbook

**Lease facts:** 135 Pierce St, San Francisco · $9,700/month · Term: Jul 1, 2026 – Aug 30, 2027 · Deposit: $9,500 (paid) · Landlord pays utilities · Optional parking $300/mo · Landlord: Philip McGarr (no property manager)

---

## At a glance

| Flow | Amount | Who |
|---|---|---|
| Rent to landlord (Zelle/wire, from tenant) | $9,700/mo | You, as tenant |
| Company reimbursement (documented business half) | $4,850/mo | Tinfoil → you (tax-free) |
| Your share (personal half, from existing salary) | $4,850/mo | You |

**The rule:** reimbursement is only for the business half, only with a log. Never a venue fee, never a salary bump, never direct payment to the landlord.

---

## One-time setup (do once)

- [ ] **Adopt the expense policy** (draft in §3) — board note or Notion page is fine
- [ ] **Send the landlord consent email** (draft in §5) and save his reply
- [ ] **Create the usage log** (template in §4) — spreadsheet or doc
- [ ] **Have your CPA bless the ~50% split** at your next tax filing

## Monthly routine (5 minutes)

1. Pay the full $9,700 to the landlord on the usual date
2. Log guests/meetings as they happen (or reconstruct at month end)
3. Submit one expense report: **rent receipt + month's log + $4,850 claim**
4. Bookkeeper reimburses and codes it as lodging/travel — no payroll tax, no W-2 impact

---

## §3 — Draft expense policy language

> **Business expense reimbursement.** The Company reimburses employees for reasonable expenses incurred on the Company's behalf, including rent allocable to lodging for visiting employees and business guests, when substantiated with receipts and a usage log. Claims are submitted within 30 days; any advance exceeding the substantiated amount is returned promptly. These reimbursements are made under an accountable plan (Treas. Reg. §1.62-2) and are excluded from wages.

---

## §4 — Usage log template

| Date(s) | Person | Relationship | Overnight? | Business purpose |
|---|---|---|---|---|
| Jul 8–10 | Jules D. | Co-founder | Yes (2 nights) | Co-founder offsite + board meeting |
| Jul 14–19 | [Visiting engineer] | Employee | Yes (5 nights) | Onboarding week |
| Jul 22 | [Name], [Name] | Employees | No | Team dinner (9 people) |
|  |  |  |  |  |

**Month total:** ___ guest-nights · ___ business meetings → claim: **$4,850**

*Daytime cofounder sessions count as business purpose — they're the strongest entries in the log. Just note them; don't bill anything extra for them.*

---

## §5 — Landlord consent email (send this)

**Subject:** Written consent — colleagues at 135 Pierce

Hi Philip,

Quick thing we'd like to have in writing, since the lease mentions the Tinfoil team: occasionally, visiting colleagues stay overnight at the apartment while working with us in SF, and from time to time we host small team dinners there.

Could you reply confirming you're OK with (1) Tinfoil colleagues and business guests staying over occasionally and (2) small company gatherings from time to time? Everything else stays exactly the same — same rent, same tenants, same terms.

Thanks!
[Name]

*His reply email = the written consent contemplated by Section XIX. File it with the lease. If he prefers signing something, this same text works as a one-page amendment.*

---

## §6 — Don'ts

| ❌ Don't | ✅ Instead |
|---|---|
| Charge Tinfoil rent or a "venue fee" for the space | Reimburse actual costs only (food, cleaning, supplies) |
| Reimburse a flat $5,000 | Reimburse the documented half — $4,850 |
| Have Tinfoil pay the landlord directly | Tenant pays landlord; company reimburses tenant |
| Bump salary to cover rent | Keep salary unchanged; reimbursement is tax-free |
| Scale events beyond dinner-party size without asking | Venue rental for the big stuff |

---

## §7 — Questions for the CPA

1. Is the usage-based ~50% allocation reasonable given the log? (Conservative is safe; over-claiming the personal share is not.)
2. Parking ($300/mo, if taken) — allocate it like rent?
3. Team-event food/drinks: deductible at 100% (employee social events) vs. client entertaining (largely non-deductible) — confirm buckets.
4. Anything to adjust at lease renewal (Aug 30, 2027 — notify landlord ≥15 days before term end for month-to-month continuation; consider re-papering with Tinfoil as co-tenant then).
`
