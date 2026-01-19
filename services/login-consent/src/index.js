import express from 'express';

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HYDRA_ADMIN_URL = process.env.HYDRA_ADMIN_URL || 'http://hydra:4445';
const KRATOS_PUBLIC_URL = process.env.KRATOS_PUBLIC_URL || 'http://kratos:4433';
const KRATOS_UI_URL = process.env.KRATOS_UI_URL || 'http://localhost:4455';

// Retry helper
async function fetchWithRetry(url, options = {}, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { ...options, timeout: 5000 });
      return res;
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      console.log(`[RETRY] attempt ${i + 1}/${maxRetries} failed, retrying...`, e.message);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

app.get('/', (req, res) => {
  res.send('<h1>Login/Consent</h1><ul><li><a href="/health">/health</a></li></ul>');
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/post-login', (req, res) => {
  res.send(`
    <h1>Registration Successful!</h1>
    <p>You have been registered. Now you can proceed with the OAuth flow.</p>
    <p><a href="http://localhost:4444/oauth2/auth?client_id=voter-app&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fpost-login&scope=openid+profile+email+vote%3Acast&state=state123">Start OAuth Flow</a></p>
  `);
});

// Login flow handler invoked by Hydra
app.get('/login', async (req, res) => {
  const challenge = req.query.login_challenge;
  if (!challenge) return res.status(400).send('missing login_challenge');
  try {
    console.log('[LOGIN] challenge:', challenge);
    
    // Try to get Kratos session using browser cookies forwarded from the request
    const whoami = await fetchWithRetry(`${KRATOS_PUBLIC_URL}/sessions/whoami`, {
      headers: { cookie: req.headers.cookie || '' }
    });

    console.log('[LOGIN] kratos whoami status:', whoami.status);

    if (whoami.ok) {
      const data = await whoami.json();
      const subject = data.identity?.id;
      console.log('[LOGIN] subject:', subject);
      if (!subject) throw new Error('no identity id in kratos session');

      // Accept login - use admin endpoint directly
      const acceptRes = await fetchWithRetry(`${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(challenge)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject, remember: true, remember_for: 3600 })
      });
      console.log('[LOGIN] hydra accept status:', acceptRes.status);
      if (!acceptRes.ok) {
        const err = await acceptRes.text();
        throw new Error(`hydra accept login failed ${acceptRes.status}: ${err}`);
      }
      const payload = await acceptRes.json();
      console.log('[LOGIN] redirect to:', payload.redirect_to);
      return res.redirect(payload.redirect_to);
    }

    console.log('[LOGIN] no session, redirecting to kratos ui');
    // Not logged in → send user to Kratos UI, and come back here after login
    const returnTo = `${req.protocol}://${req.get('host')}${req.path}?login_challenge=${encodeURIComponent(challenge)}`;
    const redirect = `${KRATOS_UI_URL}/login?return_to=${encodeURIComponent(returnTo)}`;
    console.log('[LOGIN] kratos redirect:', redirect);
    return res.redirect(302, redirect);
  } catch (e) {
    console.error('[LOGIN] error:', e);
    return res.status(500).send('login handler error: ' + e.message);
  }
});

// Consent handler invoked by Hydra
app.get('/consent', async (req, res) => {
  const challenge = req.query.consent_challenge;
  if (!challenge) return res.status(400).send('missing consent_challenge');
  try {
    // Inspect consent request to know requested scopes
    const crRes = await fetchWithRetry(`${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(challenge)}`);
    if (!crRes.ok) throw new Error(`hydra get consent failed ${crRes.status}`);
    const cr = await crRes.json();

    // Optionally read identity traits to include claims in ID token
    let idToken = {};
    try {
      const whoami = await fetchWithRetry(`${KRATOS_PUBLIC_URL}/sessions/whoami`, { headers: { cookie: req.headers.cookie || '' } });
      if (whoami.ok) {
        const s = await whoami.json();
        const traits = s.identity?.traits || {};
        if (traits.email) idToken.email = traits.email;
      }
    } catch (_) {}

    const acceptRes = await fetchWithRetry(`${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(challenge)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_scope: cr.requested_scope || [],
        remember: true,
        remember_for: 3600,
        session: { id_token: idToken, access_token: {} }
      })
    });
    if (!acceptRes.ok) throw new Error(`hydra accept consent failed ${acceptRes.status}`);
    const payload = await acceptRes.json();
    return res.redirect(payload.redirect_to);
  } catch (e) {
    console.error(e);
    return res.status(500).send('consent handler error');
  }
});

app.listen(PORT, () => console.log(`login-consent listening on :${PORT}`));
