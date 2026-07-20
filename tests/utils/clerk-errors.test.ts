import { getClerkErrorMessage } from '@/utils/clerk-errors'
import { describe, expect, it } from 'vitest'

describe('getClerkErrorMessage', () => {
  it('prefers an actionable nested message over the generic API message', () => {
    expect(
      getClerkErrorMessage(
        {
          message: 'Clerk API error',
          errors: [{ message: 'Enter the current authenticator code.' }],
        },
        'Something went wrong.',
      ),
    ).toBe('Enter the current authenticator code.')
  })

  it('prefers a nested long message when Clerk provides both forms', () => {
    expect(
      getClerkErrorMessage(
        {
          errors: [
            {
              message: 'Incorrect code.',
              longMessage: 'The authenticator code is incorrect.',
            },
          ],
        },
        'Something went wrong.',
      ),
    ).toBe('The authenticator code is incorrect.')
  })
})
