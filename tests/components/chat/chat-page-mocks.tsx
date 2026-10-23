// The chat page's surroundings, replaced for tests that render the real
// ChatInterface. vi.mock is hoisted per file, so each such file declares:
//
//   vi.mock('@clerk/react', async () => (await import('./chat-page-mocks')).clerk)
//
// and likewise for every export below. The account and router are mutable
// per test through `chatPage`.
import { useEffect, type ReactNode } from 'react'
import { vi } from 'vitest'

export const chatPage = {
  auth: { isLoaded: true, isSignedIn: true, userId: 'alice' as string | null },
  premium: false,
  router: {
    isReady: true,
    query: {} as Record<string, string>,
    asPath: '/',
    pathname: '/',
    push: vi.fn(async () => true),
    replace: vi.fn(async () => true),
  },
}

export const clerk = {
  useAuth: () => ({
    ...chatPage.auth,
    getToken: async () => (chatPage.auth.userId ? 'clerk-jwt' : null),
  }),
  useUser: () => ({
    user: chatPage.auth.userId
      ? { id: chatPage.auth.userId, firstName: 'Ada' }
      : null,
  }),
}

export const router = { useRouter: () => chatPage.router }

// Document head changes are not part of these tests.
export const head = { default: (_: { children?: ReactNode }) => null }

// Lazy modals and sidebars are not rendered.
export const dynamic = { default: () => () => null }

export const logoLoading = {
  LogoLoading: ({ onFinished }: { onFinished?: () => void }) => {
    useEffect(() => onFinished?.(), [onFinished])
    return null
  },
}

export const projects = { useProjects: () => ({ projects: [] }) }

export const subscription = {
  useSubscriptionStatus: () => ({
    isLoading: false,
    chat_subscription_active: chatPage.premium,
  }),
}

export const passkeyBackup = {
  usePasskeyBackup: () => ({
    passkeyActive: false,
    passkeyRecoveryNeeded: false,
    manualRecoveryNeeded: false,
    passkeySetupAvailable: false,
    passkeyAddDeviceAvailable: false,
    passkeySetupFailed: false,
    passkeyRecoveryFailure: null,
    passkeyFirstTimePromptAvailable: false,
    setupPasskey: vi.fn(),
    setupFirstTimePasskey: vi.fn(),
    dismissFirstTimePasskeyPrompt: vi.fn(),
    recoverWithPasskey: vi.fn(),
    setupNewKeySplit: vi.fn(),
    dismissBackupWarning: vi.fn(),
    skipPasskeyRecovery: vi.fn(),
    addPasskeyToThisDevice: vi.fn(),
    refreshBundleState: vi.fn(),
  }),
}

export const project = {
  useProject: () => ({
    activeProject: null,
    loadingProject: null,
    isProjectMode: false,
    enterProjectMode: vi.fn(),
    exitProjectMode: vi.fn(),
    createProject: vi.fn(),
    uploadDocument: vi.fn(),
  }),
  ProjectSidebar: () => null,
  ProjectModeIndicator: () => null,
}

export const chatSidebar = { ChatSidebar: () => null }

export const errorHandling = {
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}
