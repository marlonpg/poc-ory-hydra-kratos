package com.voting.auth;

import io.vertx.core.AbstractVerticle;
import io.vertx.core.Future;
import io.vertx.core.Promise;
import io.vertx.core.json.JsonArray;
import io.vertx.core.json.JsonObject;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.RoutingContext;
import io.vertx.ext.web.client.WebClient;
import io.vertx.ext.web.client.HttpResponse;
import io.vertx.core.buffer.Buffer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class LoginConsentVerticle extends AbstractVerticle {
    private static final Logger logger = LoggerFactory.getLogger(LoginConsentVerticle.class);

    private static final int PORT = Integer.parseInt(System.getenv().getOrDefault("PORT", "3001"));
    private static final String HYDRA_ADMIN_URL = System.getenv()
            .getOrDefault("HYDRA_ADMIN_URL", "http://hydra:4445");
    private static final String KRATOS_PUBLIC_URL = System.getenv()
            .getOrDefault("KRATOS_PUBLIC_URL", "http://kratos:4433");
    private static final String KRATOS_UI_URL = System.getenv()
            .getOrDefault("KRATOS_UI_URL", "http://localhost:4455");

        // OAuth client config (env-configurable)
        private static final String CLIENT_ID = System.getenv()
            .getOrDefault("CLIENT_ID", "voter-app-java");
        private static final String REDIRECT_URI = System.getenv()
            .getOrDefault("REDIRECT_URI", "http://localhost:3001/post-login");

    private WebClient webClient;

    @Override
    public void start(Promise<Void> startPromise) {
        webClient = WebClient.create(vertx);

        Router router = Router.router(vertx);

        router.get("/").handler(this::handleRoot);
        router.get("/health").handler(this::handleHealth);
        router.get("/post-login").handler(this::handlePostLogin);
        router.get("/login").handler(this::handleLogin);
        router.get("/consent").handler(this::handleConsent);

        vertx.createHttpServer()
            .requestHandler(router)
            .listen(PORT)
            .onSuccess(server -> {
                logger.info("login-consent-java listening on port {}", PORT);
                startPromise.complete();
            })
            .onFailure(startPromise::fail);
    }

    private void handleRoot(RoutingContext ctx) {
        ctx.response()
            .putHeader("content-type", "text/html")
            .end("<h1>Login/Consent (Java)</h1>" +
                 "<ul><li><a href=\"/health\">/health</a></li></ul>");
    }

    private void handleHealth(RoutingContext ctx) {
        ctx.response()
            .putHeader("content-type", "application/json")
            .end(new JsonObject().put("ok", true).encode());
    }

    private void handlePostLogin(RoutingContext ctx) {
        String authUrl = String.format(
            "http://localhost:4444/oauth2/auth?client_id=%s&response_type=code&redirect_uri=%s&scope=openid+profile+email+vote%%3Acast&state=state123",
            urlEncode(CLIENT_ID),
            urlEncode(REDIRECT_URI)
        );

        ctx.response()
            .putHeader("content-type", "text/html")
            .end("<h1>Registration Successful!</h1>" +
                 "<p>You have been registered. Now you can proceed with the OAuth flow.</p>" +
                 "<p><a href=\"" + authUrl + "\">Start OAuth Flow</a></p>");
    }

    private void handleLogin(RoutingContext ctx) {
        String challenge = ctx.queryParam("login_challenge").stream().findFirst().orElse(null);
        
        if (challenge == null) {
            ctx.response()
                .setStatusCode(400)
                .end("missing login_challenge");
            return;
        }

        logger.info("[LOGIN] challenge: {}", challenge);

        // Check Kratos session
        String cookieHeader = ctx.request().getHeader("Cookie");
        
        checkKratosSession(cookieHeader)
            .compose(sessionData -> {
                if (sessionData != null) {
                    String subject = sessionData.getString("identity_id");
                    logger.info("[LOGIN] subject: {}", subject);
                    return acceptLoginChallenge(challenge, subject);
                } else {
                    // No session - redirect to Kratos
                    logger.info("[LOGIN] no session, redirecting to kratos ui");
                    String returnTo = String.format("%s://%s%s?login_challenge=%s",
                        ctx.request().scheme(),
                        ctx.request().host(),
                        ctx.request().path(),
                        urlEncode(challenge));
                    String redirect = String.format("%s/login?return_to=%s",
                        KRATOS_UI_URL, urlEncode(returnTo));
                    logger.info("[LOGIN] kratos redirect: {}", redirect);
                    return Future.succeededFuture(redirect);
                }
            })
            .onSuccess(redirectUrl -> {
                logger.info("[LOGIN] redirect to: {}", redirectUrl);
                ctx.response()
                    .setStatusCode(302)
                    .putHeader("Location", redirectUrl)
                    .end();
            })
            .onFailure(err -> {
                logger.error("[LOGIN] error", err);
                ctx.response()
                    .setStatusCode(500)
                    .end("login handler error: " + err.getMessage());
            });
    }

    private void handleConsent(RoutingContext ctx) {
        String challenge = ctx.queryParam("consent_challenge").stream().findFirst().orElse(null);
        
        if (challenge == null) {
            ctx.response()
                .setStatusCode(400)
                .end("missing consent_challenge");
            return;
        }

        logger.info("[CONSENT] challenge: {}", challenge);

        // Get consent request
        getConsentRequest(challenge)
            .compose(consentRequest -> {
                // Try to get identity traits
                String cookieHeader = ctx.request().getHeader("Cookie");
                return getIdentityTraits(cookieHeader)
                    .compose(idToken -> acceptConsentChallenge(
                        challenge, 
                        consentRequest.getJsonArray("requested_scope"),
                        idToken
                    ));
            })
            .onSuccess(redirectUrl -> {
                logger.info("[CONSENT] redirect to: {}", redirectUrl);
                ctx.response()
                    .setStatusCode(302)
                    .putHeader("Location", redirectUrl)
                    .end();
            })
            .onFailure(err -> {
                logger.error("[CONSENT] error", err);
                ctx.response()
                    .setStatusCode(500)
                    .end("consent handler error");
            });
    }

    private Future<JsonObject> checkKratosSession(String cookieHeader) {
        Promise<JsonObject> promise = Promise.promise();

        webClient
            .getAbs(KRATOS_PUBLIC_URL + "/sessions/whoami")
            .putHeader("Cookie", cookieHeader != null ? cookieHeader : "")
            .timeout(5000)
            .send()
            .onSuccess(response -> {
                logger.info("[LOGIN] kratos whoami status: {}", response.statusCode());
                if (response.statusCode() == 200) {
                    JsonObject body = response.bodyAsJsonObject();
                    JsonObject identity = body.getJsonObject("identity");
                    if (identity != null && identity.getString("id") != null) {
                        promise.complete(new JsonObject()
                            .put("identity_id", identity.getString("id"))
                            .put("traits", identity.getJsonObject("traits")));
                    } else {
                        promise.complete(null);
                    }
                } else {
                    promise.complete(null);
                }
            })
            .onFailure(err -> {
                logger.warn("[LOGIN] kratos session check failed", err);
                promise.complete(null);
            });

        return promise.future();
    }

    private Future<String> acceptLoginChallenge(String challenge, String subject) {
        Promise<String> promise = Promise.promise();

        JsonObject body = new JsonObject()
            .put("subject", subject)
            .put("remember", true)
            .put("remember_for", 3600);

        String url = String.format("%s/admin/oauth2/auth/requests/login/accept?login_challenge=%s",
            HYDRA_ADMIN_URL, urlEncode(challenge));

        webClient
            .putAbs(url)
            .putHeader("content-type", "application/json")
            .timeout(5000)
            .sendJsonObject(body)
            .onSuccess(response -> {
                logger.info("[LOGIN] hydra accept status: {}", response.statusCode());
                if (response.statusCode() == 200) {
                    JsonObject result = response.bodyAsJsonObject();
                    promise.complete(result.getString("redirect_to"));
                } else {
                    promise.fail("hydra accept login failed: " + response.statusCode());
                }
            })
            .onFailure(promise::fail);

        return promise.future();
    }

    private Future<JsonObject> getConsentRequest(String challenge) {
        Promise<JsonObject> promise = Promise.promise();

        String url = String.format("%s/admin/oauth2/auth/requests/consent?consent_challenge=%s",
            HYDRA_ADMIN_URL, urlEncode(challenge));

        webClient
            .getAbs(url)
            .timeout(5000)
            .send()
            .onSuccess(response -> {
                if (response.statusCode() == 200) {
                    promise.complete(response.bodyAsJsonObject());
                } else {
                    promise.fail("hydra get consent failed: " + response.statusCode());
                }
            })
            .onFailure(promise::fail);

        return promise.future();
    }

    private Future<JsonObject> getIdentityTraits(String cookieHeader) {
        Promise<JsonObject> promise = Promise.promise();

        webClient
            .getAbs(KRATOS_PUBLIC_URL + "/sessions/whoami")
            .putHeader("Cookie", cookieHeader != null ? cookieHeader : "")
            .timeout(5000)
            .send()
            .onSuccess(response -> {
                JsonObject idToken = new JsonObject();
                if (response.statusCode() == 200) {
                    JsonObject body = response.bodyAsJsonObject();
                    JsonObject traits = body.getJsonObject("identity", new JsonObject())
                        .getJsonObject("traits", new JsonObject());
                    if (traits.containsKey("email")) {
                        idToken.put("email", traits.getString("email"));
                    }
                }
                promise.complete(idToken);
            })
            .onFailure(err -> {
                logger.warn("Failed to get identity traits", err);
                promise.complete(new JsonObject());
            });

        return promise.future();
    }

    private Future<String> acceptConsentChallenge(String challenge, JsonArray requestedScope, JsonObject idToken) {
        Promise<String> promise = Promise.promise();

        JsonObject session = new JsonObject()
            .put("id_token", idToken)
            .put("access_token", new JsonObject());

        JsonObject body = new JsonObject()
            .put("grant_scope", requestedScope != null ? requestedScope : new JsonArray())
            .put("remember", true)
            .put("remember_for", 3600)
            .put("session", session);

        String url = String.format("%s/admin/oauth2/auth/requests/consent/accept?consent_challenge=%s",
            HYDRA_ADMIN_URL, urlEncode(challenge));

        webClient
            .putAbs(url)
            .putHeader("content-type", "application/json")
            .timeout(5000)
            .sendJsonObject(body)
            .onSuccess(response -> {
                if (response.statusCode() == 200) {
                    JsonObject result = response.bodyAsJsonObject();
                    promise.complete(result.getString("redirect_to"));
                } else {
                    promise.fail("hydra accept consent failed: " + response.statusCode());
                }
            })
            .onFailure(promise::fail);

        return promise.future();
    }

    private String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
