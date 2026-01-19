import express from 'express';

const app = express();
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HYDRA_ADMIN_URL = process.env.HYDRA_ADMIN_URL || 'http://hydra:4445';
const KRATOS_PUBLIC_URL = process.env.KRATOS_PUBLIC_URL || 'http://kratos:4433';
const KRATOS_UI_URL = process.env.KRATOS_UI_URL || 'http://localhost:4455';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Request failed ${res.status} ${url}`);
  return res.json();
}

app.get('/', (req, res) => {
  res.send('<h1>Login/Consent</h1><ul><li><a href="/health">/health</a></li></ul>');
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Login flow handler invoked by Hydra
app.get('/login', async (req, res) => {
  const challenge = req.query.login_challenge;
  if (!challenge) return res.status(400).send('missing login_challenge');
  try {
    // Try to get Kratos session using browser cookies forwarded from the request
    const whoami = await fetch(`${KRATOS_PUBLIC_URL}/sessions/whoami`, {
      headers: { cookie: req.headers.cookie || '' }
    });

    if (whoami.ok) {
      const data = await whoami.json();
      const subject = data.identity?.id;
      if (!subject) throw new Error('no identity id in kratos session');

      // Accept login
      const acceptRes = await fetch(`${HYDRA_ADMIN_URL}/oauth2/auth/requests/login/accept?login_challenge=${encodeURIComponent(challenge)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject, remember: true, remember_for: 3600 })
      });
      if (!acceptRes.ok) throw new Error(`hydra accept login failed ${acceptRes.status}`);
      const payload = await acceptRes.json();
      return res.redirect(payload.redirect_to);
    }

    // Not logged in → send user to Kratos UI, and come back here after login
    const returnTo = `${req.protocol}://${req.get('host')}${req.path}?login_challenge=${encodeURIComponent(challenge)}`;
    const redirect = `${KRATOS_UI_URL}/login?return_to=${encodeURIComponent(returnTo)}`;
    return res.redirect(302, redirect);
  } catch (e) {
    console.error(e);
    return res.status(500).send('login handler error');
  }
});

// Consent handler invoked by Hydra
app.get('/consent', async (req, res) => {
  const challenge = req.query.consent_challenge;
  if (!challenge) return res.status(400).send('missing consent_challenge');
  try {
    // Inspect consent request to know requested scopes
    const crRes = await fetch(`${HYDRA_ADMIN_URL}/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(challenge)}`);
    if (!crRes.ok) throw new Error(`hydra get consent failed ${crRes.status}`);
    const cr = await crRes.json();

    // Optionally read identity traits to include claims in ID token
    let idToken = {};
    try {
      const whoami = await fetch(`${KRATOS_PUBLIC_URL}/sessions/whoami`, { headers: { cookie: req.headers.cookie || '' } });
      if (whoami.ok) {
        const s = await whoami.json();
        const traits = s.identity?.traits || {};
        if (traits.email) idToken.email = traits.email;
      }
    } catch (_) {}

    const acceptRes = await fetch(`${HYDRA_ADMIN_URL}/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(challenge)}`, {
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
