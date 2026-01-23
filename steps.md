# Simple analogy
## Your Google login example:

1. Click "Login with Google" on website
2. Redirected to Google → authenticate (enter password, 2FA, etc.)
3. Google shows consent screen: "Website XYZ wants access to: email, profile, etc."
4. You click "Allow" → redirected back to website with a code
5. Website exchanges code for tokens from Google

## Our voting system (Hydra + Kratos):

1. Click "Login" on voting app → redirected to Hydra (like Google)
   ```
   GET https://hydra.example.com/oauth2/auth?client_id=voter-app&response_type=code&redirect_uri=https://vote.example.com/callback&scope=openid+profile+email+vote:cast&state=random123
   ```

2. Hydra creates login_challenge, redirects to Login/Consent Service
   ```
   GET https://login.example.com/login?login_challenge=abc123...
   ```

3. Login/Consent Service redirects you to Kratos → authenticate (register or login)
   ```
   GET https://kratos.example.com/self-service/registration/browser
   (or GET https://kratos.example.com/self-service/login/browser)
   ```

4. Kratos confirms identity → redirected back to Login/Consent Service
   ```
   Internal: POST https://kratos.example.com/self-service/registration?flow=<flow_id> (form submission)
   Redirect: GET https://login.example.com/login?login_challenge=abc123...
   ```

5. Login/Consent Service accepts the login_challenge with Kratos identity
   ```
   Internal (Server-to-Server): PUT https://hydra-admin.example.com:4445/admin/oauth2/auth/requests/login/accept?login_challenge=abc123
   Body: { "subject": "<kratos_identity_id>", "remember": true }
   ```

6. Hydra creates consent_challenge → shows consent screen: "Allow voting app to access: email, voting rights, etc."
   ```
   Redirect: GET https://login.example.com/consent?consent_challenge=def456...
   Internal: GET https://hydra-admin.example.com:4445/admin/oauth2/auth/requests/consent?consent_challenge=def456
   ```

7. You click "Allow" → redirected back to voting app with authorization code
   ```
   Internal (Server-to-Server): PUT https://hydra-admin.example.com:4445/admin/oauth2/auth/requests/consent/accept?consent_challenge=def456
   Redirect: GET https://vote.example.com/callback?code=xyz789&state=random123
   ```

8. Voting app exchanges code for tokens from Hydra
   ```
   Internal (Server-to-Server): POST https://hydra.example.com/oauth2/token
   Headers: Authorization: Basic <base64(client_id:client_secret)>
   Body: grant_type=authorization_code&code=xyz789&redirect_uri=https://vote.example.com/callback
   ```

