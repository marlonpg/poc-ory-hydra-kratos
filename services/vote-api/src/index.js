import express from 'express';
import { jwtVerify, createRemoteJWKSet } from 'jose';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const OIDC_ISSUER_URL = (process.env.OIDC_ISSUER_URL || 'http://localhost:4444/').replace(/\/$/, '');
const REQUIRED_SCOPE = process.env.REQUIRED_SCOPE || 'vote:cast';

// In-memory store for demo (replace with DB/Kafka for real system)
let votes = [];

// JWKS cache for token verification
let jwksCache = null;

async function getJWKS() {
  if (!jwksCache) {
    const url = `${OIDC_ISSUER_URL}/.well-known/jwks.json`;
    console.log(`Fetching JWKS from ${url}`);
    jwksCache = createRemoteJWKSet(new URL(url));
  }
  return jwksCache;
}

async function verifyToken(token) {
  const jwks = await getJWKS();
  const result = await jwtVerify(token, jwks, {
    issuer: `${OIDC_ISSUER_URL}/`,
    audience: undefined // Hydra doesn't always enforce audience for access tokens
  });
  return result.payload;
}

app.get('/', (req, res) => {
  res.json({ service: 'vote-api', status: 'ok' });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/vote', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const token = authHeader.slice(7);
    const payload = await verifyToken(token);

    console.log('Token payload:', payload);

    // Check scopes (stored as space-separated string in access token)
    const scopes = (payload.scope || '').split(' ');
    if (!scopes.includes(REQUIRED_SCOPE)) {
      return res.status(403).json({ error: 'insufficient scopes' });
    }

    const { electionId, candidateId } = req.body;
    if (!electionId || !candidateId) {
      return res.status(400).json({ error: 'electionId and candidateId required' });
    }

    const sub = payload.sub;

    // Enforce one vote per voter per election
    const existing = votes.find(v => v.electionId === electionId && v.sub === sub);
    if (existing) {
      return res.status(409).json({ error: 'already voted in this election' });
    }

    const vote = {
      id: Math.random().toString(36).slice(2),
      electionId,
      candidateId,
      sub,
      votedAt: new Date().toISOString()
    };
    votes.push(vote);

    res.status(201).json({ success: true, vote });
  } catch (e) {
    console.error(e);
    if (e.code === 'ERR_JWT_INVALID') {
      return res.status(401).json({ error: 'invalid token' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/votes', (req, res) => {
  res.json(votes);
});

app.get('/votes/:electionId', (req, res) => {
  const { electionId } = req.params;
  const filtered = votes.filter(v => v.electionId === electionId);
  const counts = {};
  filtered.forEach(v => {
    counts[v.candidateId] = (counts[v.candidateId] || 0) + 1;
  });
  res.json({ electionId, total: filtered.length, counts });
});

app.listen(PORT, () => console.log(`vote-api listening on :${PORT}`));
