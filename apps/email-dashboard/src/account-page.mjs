export async function renderAccountPage(body, url) {
  const signup = url.pathname === '/sign-up', confirming = url.pathname === '/magic-link'
  const values = {
    'page-title': signup ? 'Sign up' : 'Sign in',
    title: confirming ? 'You’re one click away.' : signup ? 'Make room for your email.' : 'Welcome back.',
    description: confirming ? 'Sign in as your account. Continue only if this is your email address.' : signup ? 'Create your account with a sign-in link or email code.' : 'A link or a code. Your inbox is one email away.',
    'name-hidden': signup ? '' : 'hidden',
    'name-required': signup ? 'required' : '',
    'email-hidden': confirming ? 'hidden' : '',
    'email-required': confirming ? '' : 'required',
    'method-hidden': confirming ? 'hidden' : '',
    'submit-label': confirming ? 'Continue to workspace' : 'Email me a sign-in link',
    'submit-disabled': confirming ? 'disabled' : '',
    error: url.searchParams.get('reason') === 'access_denied' ? 'Your account does not have access to this workspace. Contact the owner.' : url.searchParams.has('error') ? 'This sign-in link is invalid, expired, or already used. Request a new one below.' : '',
    'alternate-copy': confirming ? '' : signup ? 'Already have an account? ' : 'New to Bezalel? ',
    'alternate-href': signup || confirming ? '/sign-in' : '/sign-up',
    'alternate-label': signup ? 'Sign in' : confirming ? 'Request a new sign-in email' : 'Create an account',
  }
  const template = await new Response(body).text()
  return template.replace(/\{\{([a-z-]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown account page field: ${key}`)
    return values[key]
  })
}
