import { authTokenManager } from '@/services/auth'
import { resetTinfoilClient } from '@/services/inference/tinfoil-client'
import { useAuth } from '@clerk/react'
import { useEffect } from 'react'

export function AuthTokenSync() {
  const { getToken, isLoaded, isSignedIn, sessionId, userId } = useAuth()

  useEffect(() => {
    if (isLoaded) {
      authTokenManager.initialize(isSignedIn ? getToken : null)
    }

    return () => {
      authTokenManager.reset()
      resetTinfoilClient()
    }
  }, [getToken, isLoaded, isSignedIn, sessionId, userId])

  return null
}
