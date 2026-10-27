import { createServer, type Server } from "node:http";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdirSync,
  openSync,
  closeSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { CompanyScope } from "./scope.ts";
import { runtimePath } from "./setup.ts";
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN = ISSUER + "/api/accounts/oauth/token";
const REQUIRED = ["resource.invoke", "chatgpt.tokens.use.direct"];
interface Account {
  clientId: string;
  subject: string;
  email?: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scopes: string[];
  model?: string;
}
interface Saved {
  hostId: string;
  active?: string;
  accounts: Record<string, Account>;
}
export interface AuthDependencies {
  path?: string;
  fetcher?: typeof fetch;
  verify?: (token: string, audience: string) => Promise<Record<string, any>>;
}
/** Official public-client registration + OAuth PKCE. No Codex/Steward credentials are imported. */
export class ChatGPTAuth {
  private readonly path: string;
  private readonly fetcher: typeof fetch;
  private refresh?: Promise<string>;
  private pending?: {
    server: Server;
    timer: ReturnType<typeof setTimeout>;
    state: string;
    status: string;
    error?: string;
    url: string;
    done: Promise<void>;
    cancel: () => void;
  };
  constructor(private readonly deps: AuthDependencies = {}) {
    this.path =
      deps.path ??
      (process.env.WETROP_TEST_MODE === "1"
        ? new CompanyScope().parent(".wetrop/tmp/test-chatgpt.json", true)
        : runtimePath("chatgpt/accounts.json"));
    this.fetcher = deps.fetcher ?? fetch;
  }
  private load(): Saved {
    if (existsSync(this.path))
      return JSON.parse(readFileSync(this.path, "utf8"));
    const state = { hostId: `urn:uuid:${randomUUID()}`, accounts: {} };
    this.save(state);
    return state;
  }
  private save(s: Saved) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = this.path + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify(s, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temp, this.path);
  }
  status() {
    const s = this.load();
    const a = s.active ? s.accounts[s.active] : undefined;
    return {
      provider: "chatgpt",
      connected: !!a?.accessToken,
      accountId: s.active,
      email: a?.email,
      name: a?.name,
      model: a?.model,
      scopes: a?.scopes ?? [],
      accounts: Object.entries(s.accounts).map(([id, a]) => ({
        id,
        email: a.email,
        name: a.name,
        connected: !!a.accessToken,
        model: a.model,
      })),
      login: this.pending
        ? { status: this.pending.status, error: this.pending.error }
        : undefined,
    };
  }
  private async verify(token: string, audience: string) {
    if (this.deps.verify) return this.deps.verify(token, audience);
    const discovery = await this.fetcher(
      ISSUER + "/.well-known/openid-configuration",
      { signal: AbortSignal.timeout(15000) },
    );
    if (!discovery.ok)
      throw new Error("Unable to load OpenAI identity configuration");
    const metadata: any = await discovery.json();
    if (
      metadata.issuer !== ISSUER ||
      new URL(metadata.jwks_uri).origin !== ISSUER
    )
      throw new Error("Unexpected OpenAI identity issuer");
    const { payload } = await jwtVerify(
      token,
      createRemoteJWKSet(new URL(metadata.jwks_uri)),
      { issuer: ISSUER, audience, clockTolerance: 15 },
    );
    return payload;
  }
  async start(accountId?: string) {
    if (this.pending?.status === "pending")
      return { url: this.pending.url, done: this.pending.done };
    const saved = this.load();
    accountId ??= saved.active;
    const account = accountId ? saved.accounts[accountId] : undefined;
    if (accountId && !account) throw new Error("Unknown ChatGPT registration");
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let timeout: ReturnType<typeof setTimeout>;
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (u.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const incoming = Buffer.from(u.searchParams.get("state") ?? ""),
        expected = Buffer.from(state);
      if (
        incoming.length !== expected.length ||
        !timingSafeEqual(incoming, expected)
      ) {
        res.writeHead(403);
        res.end("Invalid sign-in state");
        return;
      }
      try {
        if (u.searchParams.has("error"))
          throw new Error(
            `ChatGPT sign-in was not authorized (${u.searchParams.get("error")})`,
          );
        const code = u.searchParams.get("code");
        const issued = u.searchParams.get("client_id") ?? account?.clientId;
        if (!code || !issued || issued === "dynamic_agent_client")
          throw new Error("Registration did not return an issued client ID");
        if (account && issued !== account.clientId)
          throw new Error(
            "The callback changed the selected client registration",
          );
        const response = await this.fetcher(TOKEN, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: issued,
            code,
            code_verifier: verifier,
            redirect_uri: redirect,
            resource: RESOURCE,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok)
          throw new Error(
            `ChatGPT token exchange failed (${response.status}); start a fresh sign-in`,
          );
        const tokens: any = await response.json();
        if (!tokens.id_token || !tokens.access_token)
          throw new Error("Sign-in did not return identity and access tokens");
        const claims = await this.verify(tokens.id_token, issued);
        if (claims.nonce !== nonce || typeof claims.sub !== "string")
          throw new Error("Invalid identity nonce or subject");
        if (account && claims.sub !== account.subject)
          throw new Error(
            "Signed-in identity does not match the selected account",
          );
        const scopes = String(tokens.scope ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (REQUIRED.some((s) => !scopes.includes(s)))
          throw new Error(
            "ChatGPT plan usage was not authorized; identity-only sign-in cannot run Wetrop",
          );
        const latest = this.load();
        const id = `${issued}:${claims.sub}`;
        latest.accounts[id] = {
          clientId: issued,
          subject: claims.sub,
          email: typeof claims.email === "string" ? claims.email : undefined,
          name: typeof claims.name === "string" ? claims.name : undefined,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token,
          expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
          scopes,
          model: latest.accounts[id]?.model,
        };
        latest.active = id;
        this.save(latest);
        this.pending!.status = "connected";
        res.end(
          "Wetrop is connected to your ChatGPT plan. You can close this tab and return to Wetrop.",
        );
      } catch (e) {
        this.pending!.status = "failed";
        this.pending!.error = e instanceof Error ? e.message : "Sign-in failed";
        res.writeHead(400);
        res.end(this.pending!.error);
      } finally {
        clearTimeout(timeout);
        server.close();
        resolveDone();
      }
    });
    await new Promise<void>((r, j) => {
      server.once("error", j);
      server.listen(0, "127.0.0.1", r);
    });
    const address = server.address() as any;
    const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(ISSUER + "/api/accounts/authorize");
    const params: Record<string, string> = {
      client_id: account?.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: saved.hostId,
      response_type: "code",
      redirect_uri: redirect,
      scope:
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    };
    if (!account) params.agent_name_hint = "Wetrop";
    else if (account.email) params.login_hint = account.email;
    // Do not expose retained ID tokens in an authorization URL or browser storage.
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    timeout = setTimeout(
      () => {
        if (this.pending?.status === "pending") {
          this.pending.status = "expired";
          server.close();
          resolveDone();
        }
      },
      10 * 60 * 1000,
    );
    this.pending = {
      server,
      timer: timeout,
      state,
      status: "pending",
      url: url.href,
      done,
      cancel: () => {
        clearTimeout(timeout);
        server.close();
        resolveDone();
      },
    };
    return { url: url.href, done };
  }
  async token() {
    if (this.refresh) return this.refresh;
    this.refresh = this.withRefreshLock(() => this.readOrRefresh());
    try {
      return await this.refresh;
    } finally {
      this.refresh = undefined;
    }
  }
  private async withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
    const path = this.path + ".refresh.lock";
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        try {
          return await operation();
        } finally {
          rmSync(path, { force: true });
        }
      } catch (error) {
        if ((error as any).code !== "EEXIST") throw error;
        try {
          const pid = Number(readFileSync(path, "utf8"));
          if (statSync(path).mtimeMs < Date.now() - 60000) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              if ((e as any).code === "ESRCH") rmSync(path, { force: true });
            }
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("ChatGPT session is busy refreshing; retry the operation");
  }
  private async readOrRefresh() {
    const s = this.load(),
      a = s.active ? s.accounts[s.active] : undefined;
    if (!a?.accessToken)
      throw new Error(
        "Continue with ChatGPT in Company settings before running the agent",
      );
    if ((a.expiresAt ?? 0) > Date.now() + 60000) return a.accessToken;
    if (!a.refreshToken)
      throw new Error("ChatGPT session expired. Sign in again.");
    const r = await this.fetcher(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: a.clientId,
        refresh_token: a.refreshToken,
        resource: RESOURCE,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok)
      throw new Error(
        `ChatGPT session refresh failed (${r.status}); sign in again. No API-key fallback was used.`,
      );
    const t: any = await r.json();
    if (!t.access_token)
      throw new Error("Missing refreshed ChatGPT access token");
    const latest = this.load();
    if (latest.active !== s.active)
      throw new Error("ChatGPT account changed during refresh");
    latest.accounts[s.active!] = {
      ...latest.accounts[s.active!],
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? a.refreshToken,
      idToken: t.id_token ?? a.idToken,
      expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000,
    };
    this.save(latest);
    return t.access_token;
  }
  async models() {
    const token = await this.token();
    const r = await this.fetcher(RESOURCE + "/models", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok)
      throw new Error(`ChatGPT model catalog unavailable (${r.status})`);
    const body: any = await r.json();
    return (body.models ?? [])
      .filter((m: any) => m.visibility === "list")
      .map((m: any) => ({ id: m.slug, name: m.display_name ?? m.slug }));
  }
  async selectModel(model: string) {
    const available = await this.models();
    if (!available.some((m: any) => m.id === model))
      throw new Error("Model is not in the selected ChatGPT account catalog");
    const s = this.load();
    s.accounts[s.active!].model = model;
    this.save(s);
  }
  async activate(id: string) {
    const s = this.load();
    if (!s.accounts[id]?.accessToken)
      throw new Error("Sign in to this account first");
    s.active = id;
    this.save(s);
  }
  async logout() {
    const s = this.load(),
      a = s.active ? s.accounts[s.active] : undefined;
    let revoked = true;
    if (a?.refreshToken) {
      try {
        const d = await this.fetcher(
          ISSUER + "/.well-known/openid-configuration",
          { signal: AbortSignal.timeout(15000) },
        );
        const metadata: any = await d.json();
        const endpoint = new URL(metadata.revocation_endpoint);
        if (endpoint.origin !== ISSUER)
          throw new Error("Invalid revocation endpoint");
        const r = await this.fetcher(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: a.refreshToken,
            token_type_hint: "refresh_token",
            client_id: a.clientId,
          }),
          signal: AbortSignal.timeout(15000),
        });
        revoked = r.ok;
      } catch {
        revoked = false;
      }
    }
    if (a) {
      delete a.accessToken;
      delete a.refreshToken;
      delete a.idToken;
      delete a.expiresAt;
      delete s.active;
      this.save(s);
    }
    return {
      revoked,
      message: revoked
        ? "Signed out"
        : "Signed out locally. Remote revocation was not confirmed; disconnect Wetrop in ChatGPT Settings.",
    };
  }
  close() {
    this.pending?.cancel();
  }
}
