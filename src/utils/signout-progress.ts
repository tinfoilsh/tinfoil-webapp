type Listener = (state: SignoutProgressState) => void

export interface SignoutProgressState {
  visible: boolean
  steps: SignoutStep[]
}

export interface SignoutStep {
  label: string
  status: 'pending' | 'active' | 'done'
}

const SIGNOUT_STEP_LABELS = [
  'Signing out of Clerk',
  'Clearing encryption key',
  'Resetting in-memory caches',
  'Clearing local storage',
  'Clearing browsing data',
  'Reloading',
] as const

export const SIGNOUT_STEPS = {
  SIGN_OUT: 0,
  CLEAR_KEY: 1,
  RESET_CACHES: 2,
  CLEAR_STORAGE: 3,
  CLEAR_BROWSING_DATA: 4,
  RELOAD: 5,
} as const

function freshSteps(): SignoutStep[] {
  return SIGNOUT_STEP_LABELS.map((label) => ({ label, status: 'pending' }))
}

function withSteps(
  steps: SignoutStep[],
  index: number,
  includeIndexAsDone: boolean,
): SignoutStep[] {
  return steps.map((step, i) => ({
    ...step,
    status:
      i < index || (includeIndexAsDone && i === index)
        ? 'done'
        : i === index
          ? 'active'
          : 'pending',
  }))
}

let currentState: SignoutProgressState = {
  visible: false,
  steps: freshSteps(),
}

const listeners = new Set<Listener>()

function cloneState(): SignoutProgressState {
  return {
    visible: currentState.visible,
    steps: currentState.steps.map((s) => ({ ...s })),
  }
}

function emit(): void {
  const snapshot = cloneState()
  for (const listener of listeners) {
    listener(snapshot)
  }
}

export function subscribeToSignoutProgress(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSignoutProgressState(): SignoutProgressState {
  return cloneState()
}

export function showSignoutProgress(): void {
  currentState = { visible: true, steps: freshSteps() }
  emit()
}

export function reportSignoutStep(index: number): void {
  currentState = {
    visible: true,
    steps: withSteps(currentState.steps, index, false),
  }
  emit()
}

export function completeSignoutStep(index: number): void {
  currentState = {
    visible: true,
    steps: withSteps(currentState.steps, index, true),
  }
  emit()
}

export function hideSignoutProgress(): void {
  currentState = { visible: false, steps: freshSteps() }
  emit()
}
