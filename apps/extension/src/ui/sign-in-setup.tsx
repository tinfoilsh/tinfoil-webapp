// What a build that was given no sign-in service asks of whoever built it.
export function SignInSetup() {
  return (
    <>
      Set <code>WXT_CLERK_PUBLISHABLE_KEY</code> and{' '}
      <code>WXT_CLERK_FRONTEND_API</code> in <code>apps/extension/.env</code>,
      then reload the extension.
    </>
  )
}
