export const REASONING_HISTORY_POLICIES = {
  none: 'none',
  toolCallOnly: 'tool-call-only',
  all: 'all',
} as const

export type ReasoningHistoryPolicy =
  (typeof REASONING_HISTORY_POLICIES)[keyof typeof REASONING_HISTORY_POLICIES]

export const normalizeReasoningHistoryPolicy = (
  value: unknown,
): ReasoningHistoryPolicy => {
  switch (value) {
    case REASONING_HISTORY_POLICIES.all:
    case REASONING_HISTORY_POLICIES.toolCallOnly:
    case REASONING_HISTORY_POLICIES.none:
      return value
    default:
      return REASONING_HISTORY_POLICIES.none
  }
}

const REASONING_HISTORY_POLICY_RANK: Record<ReasoningHistoryPolicy, number> = {
  [REASONING_HISTORY_POLICIES.none]: 0,
  [REASONING_HISTORY_POLICIES.toolCallOnly]: 1,
  [REASONING_HISTORY_POLICIES.all]: 2,
}

export const getStrongerReasoningHistoryPolicy = (
  first: ReasoningHistoryPolicy,
  second: ReasoningHistoryPolicy,
): ReasoningHistoryPolicy =>
  REASONING_HISTORY_POLICY_RANK[second] > REASONING_HISTORY_POLICY_RANK[first]
    ? second
    : first

export const shouldIncludeReasoning = (
  policy: ReasoningHistoryPolicy,
  hasToolCalls: boolean,
): boolean =>
  policy === REASONING_HISTORY_POLICIES.all ||
  (policy === REASONING_HISTORY_POLICIES.toolCallOnly && hasToolCalls)
