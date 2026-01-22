package com.voting.api;

import io.vertx.core.AbstractVerticle;
import io.vertx.core.Future;
import io.vertx.core.Promise;
import io.vertx.core.buffer.Buffer;
import io.vertx.core.json.JsonArray;
import io.vertx.core.json.JsonObject;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.RoutingContext;
import io.vertx.ext.web.client.WebClient;
import io.vertx.ext.web.handler.BodyHandler;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.JWSAlgorithm;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URL;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class VoteApiVerticle extends AbstractVerticle {
    private static final Logger logger = LoggerFactory.getLogger(VoteApiVerticle.class);

    private static final int PORT = Integer.parseInt(System.getenv().getOrDefault("PORT", "4000"));
    private static final String ISSUER_EXPECTED = System.getenv()
            .getOrDefault("OIDC_ISSUER_URL_PUBLIC", "http://localhost:4444/")
            .replaceAll("/$", "");
    private static final String JWKS_URL = System.getenv()
            .getOrDefault("OIDC_JWKS_URL", "http://hydra:4444/.well-known/jwks.json");
    private static final String REQUIRED_SCOPE = System.getenv()
            .getOrDefault("REQUIRED_SCOPE", "vote:cast");

    // In-memory store (replace with PostgreSQL/Kafka for production)
    private final List<JsonObject> votes = Collections.synchronizedList(new ArrayList<>());
    
    // JWKS cache
    private DefaultJWTProcessor<SecurityContext> jwtProcessor;
    private WebClient webClient;

    @Override
    public void start(Promise<Void> startPromise) {
        webClient = WebClient.create(vertx);
        
        // Initialize JWKS cache
        initializeJWKS()
            .compose(v -> setupRouter())
            .onSuccess(router -> {
                vertx.createHttpServer()
                    .requestHandler(router)
                    .listen(PORT)
                    .onSuccess(server -> {
                        logger.info("vote-api-java listening on port {}", PORT);
                        startPromise.complete();
                    })
                    .onFailure(startPromise::fail);
            })
            .onFailure(startPromise::fail);
    }

    private Future<Void> initializeJWKS() {
        Promise<Void> promise = Promise.promise();
        
        logger.info("Fetching JWKS from {}", JWKS_URL);
        
        try {
            // Fetch JWKS and cache it
            URL jwksUrl = new URL(JWKS_URL);
            JWKSet jwkSet = JWKSet.load(jwksUrl);
            
            JWKSource<SecurityContext> jwkSource = new ImmutableJWKSet<>(jwkSet);
            
            jwtProcessor = new DefaultJWTProcessor<>();
            jwtProcessor.setJWSKeySelector(
                new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, jwkSource)
            );
            
            // Set claims verifier for issuer
            jwtProcessor.setJWTClaimsSetVerifier(
                new DefaultJWTClaimsVerifier<>(
                    new JWTClaimsSet.Builder()
                        .issuer(ISSUER_EXPECTED + "/")
                        .build(),
                    new HashSet<>(Arrays.asList("sub", "exp", "iat"))
                )
            );
            
            logger.info("JWKS cached successfully");
            promise.complete();
        } catch (Exception e) {
            logger.error("Failed to fetch JWKS", e);
            promise.fail(e);
        }
        
        return promise.future();
    }

    private Future<Router> setupRouter() {
        Router router = Router.router(vertx);
        
        router.route().handler(BodyHandler.create());
        
        router.get("/").handler(this::handleRoot);
        router.get("/health").handler(this::handleHealth);
        router.post("/vote").handler(this::handleVote);
        router.get("/votes").handler(this::handleGetVotes);
        router.get("/votes/:electionId").handler(this::handleGetElectionVotes);
        
        return Future.succeededFuture(router);
    }

    private void handleRoot(RoutingContext ctx) {
        ctx.response()
            .putHeader("content-type", "application/json")
            .end(new JsonObject()
                .put("service", "vote-api-java")
                .put("status", "ok")
                .encode());
    }

    private void handleHealth(RoutingContext ctx) {
        ctx.response()
            .putHeader("content-type", "application/json")
            .end(new JsonObject().put("ok", true).encode());
    }

    private void handleVote(RoutingContext ctx) {
        String authHeader = ctx.request().getHeader("Authorization");
        
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            ctx.response()
                .setStatusCode(401)
                .putHeader("content-type", "application/json")
                .end(new JsonObject().put("error", "unauthorized").encode());
            return;
        }

        String token = authHeader.substring(7);
        
        verifyToken(token)
            .onSuccess(claims -> processVote(ctx, claims))
            .onFailure(err -> {
                logger.error("Token verification failed", err);
                ctx.response()
                    .setStatusCode(401)
                    .putHeader("content-type", "application/json")
                    .end(new JsonObject().put("error", "invalid token").encode());
            });
    }

    private Future<JWTClaimsSet> verifyToken(String token) {
        return vertx.executeBlocking(promise -> {
            try {
                JWTClaimsSet claims = jwtProcessor.process(token, null);
                promise.complete(claims);
            } catch (Exception e) {
                promise.fail(e);
            }
        });
    }

    private void processVote(RoutingContext ctx, JWTClaimsSet claims) {
        try {
            // Check scopes
            List<String> scopes = extractScopes(claims);
            if (!scopes.contains(REQUIRED_SCOPE)) {
                ctx.response()
                    .setStatusCode(403)
                    .putHeader("content-type", "application/json")
                    .end(new JsonObject().put("error", "insufficient scopes").encode());
                return;
            }

            JsonObject body = ctx.body().asJsonObject();
            if (body == null) {
                ctx.response()
                    .setStatusCode(400)
                    .putHeader("content-type", "application/json")
                    .end(new JsonObject().put("error", "invalid json body").encode());
                return;
            }

            String electionId = body.getString("electionId");
            String candidateId = body.getString("candidateId");

            if (electionId == null || candidateId == null) {
                ctx.response()
                    .setStatusCode(400)
                    .putHeader("content-type", "application/json")
                    .end(new JsonObject()
                        .put("error", "electionId and candidateId required")
                        .encode());
                return;
            }

            String sub = claims.getSubject();

            // Check for existing vote
            synchronized (votes) {
                boolean alreadyVoted = votes.stream()
                    .anyMatch(v -> v.getString("electionId").equals(electionId) 
                                && v.getString("sub").equals(sub));

                if (alreadyVoted) {
                    ctx.response()
                        .setStatusCode(409)
                        .putHeader("content-type", "application/json")
                        .end(new JsonObject()
                            .put("error", "already voted in this election")
                            .encode());
                    return;
                }

                // Record vote
                JsonObject vote = new JsonObject()
                    .put("id", UUID.randomUUID().toString())
                    .put("electionId", electionId)
                    .put("candidateId", candidateId)
                    .put("sub", sub)
                    .put("votedAt", new Date().toInstant().toString());

                votes.add(vote);

                logger.info("Vote recorded: election={}, candidate={}, voter={}", 
                    electionId, candidateId, sub);

                ctx.response()
                    .setStatusCode(201)
                    .putHeader("content-type", "application/json")
                    .end(new JsonObject()
                        .put("success", true)
                        .put("vote", vote)
                        .encode());
            }
        } catch (Exception e) {
            logger.error("Error processing vote", e);
            ctx.response()
                .setStatusCode(500)
                .putHeader("content-type", "application/json")
                .end(new JsonObject().put("error", e.getMessage()).encode());
        }
    }

    private List<String> extractScopes(JWTClaimsSet claims) {
        try {
            // Try 'scope' (space-separated string)
            String scopeString = claims.getStringClaim("scope");
            if (scopeString != null) {
                return Arrays.asList(scopeString.split(" "));
            }

            // Try 'scp' (array)
            List<String> scpArray = claims.getStringListClaim("scp");
            if (scpArray != null) {
                return scpArray;
            }
        } catch (Exception e) {
            logger.warn("Failed to extract scopes", e);
        }
        return Collections.emptyList();
    }

    private void handleGetVotes(RoutingContext ctx) {
        JsonArray result = new JsonArray();
        synchronized (votes) {
            votes.forEach(result::add);
        }
        ctx.response()
            .putHeader("content-type", "application/json")
            .end(result.encode());
    }

    private void handleGetElectionVotes(RoutingContext ctx) {
        String electionId = ctx.pathParam("electionId");
        
        Map<String, Integer> counts = new ConcurrentHashMap<>();
        int total;
        
        synchronized (votes) {
            List<JsonObject> filtered = votes.stream()
                .filter(v -> v.getString("electionId").equals(electionId))
                .toList();
            
            total = filtered.size();
            filtered.forEach(v -> {
                String candidateId = v.getString("candidateId");
                counts.merge(candidateId, 1, Integer::sum);
            });
        }

        ctx.response()
            .putHeader("content-type", "application/json")
            .end(new JsonObject()
                .put("electionId", electionId)
                .put("total", total)
                .put("counts", new JsonObject((Buffer) counts))
                .encode());
    }
}
