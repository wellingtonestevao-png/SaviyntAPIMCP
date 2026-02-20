import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import * as z from "zod/v4";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type JsonObject = Record<string, unknown>;

interface SaviyntProfileState {
  profileId: string;
  username: string;
  password: string;
  baseUrl: string;
  source: "session" | "env";
  updatedAt: number;
}

interface SaviyntTokenState {
  bearerToken?: string;
  tokenExpiresAt?: number;
}

interface ApiRequestOptions {
  endpoint: string;
  method?: HttpMethod;
  query?: JsonObject;
  body?: JsonObject;
  baseUrl?: string;
  profileId?: string;
  requiresAuth?: boolean;
  retryOnUnauthorized?: boolean;
}

export interface CreateSaviyntServerOptions {
  defaultBaseUrl?: string;
  enableWrites?: boolean;
}

const LOGIN_ENDPOINTS = ["/ECM/api/login", "/ECM/api/v1/token"];
const WRITE_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);
const TEXT_CONTENT = "text" as const;
const DEFAULT_MAX_RESULT_TEXT_CHARS = 20000;
const DEFAULT_MAX_STRUCTURED_CONTENT_CHARS = 4000;
const DEFAULT_PROFILE_ID = "default";
const ENV_PROFILE_ID = "env-default";

class LoginRequiredError extends Error {}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeApiPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncate(text: string, maxLength = 2000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated]`;
}

function asJsonText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function okResult(value: unknown): CallToolResult {
  const maxTextChars = positiveIntFromEnv(
    process.env.SAVIYNT_MAX_RESULT_TEXT_CHARS,
    DEFAULT_MAX_RESULT_TEXT_CHARS
  );
  const maxStructuredChars = positiveIntFromEnv(
    process.env.SAVIYNT_MAX_STRUCTURED_CONTENT_CHARS,
    DEFAULT_MAX_STRUCTURED_CONTENT_CHARS
  );
  const fullText = asJsonText(value);

  if (fullText.length > maxTextChars) {
    const truncatedText =
      `${fullText.slice(0, maxTextChars)}\n\n` +
      `... [truncated ${fullText.length - maxTextChars} chars due to MCP response size limit]`;

    return {
      content: [{ type: TEXT_CONTENT, text: truncatedText }],
      structuredContent: {
        success: true,
        truncated: true,
        originalChars: fullText.length,
        returnedChars: maxTextChars,
        message:
          "Result was truncated to keep the MCP payload size safe for clients. Add tighter filters/limits.",
      },
    };
  }

  const response: CallToolResult = {
    content: [{ type: TEXT_CONTENT, text: fullText }],
  };

  if (isRecord(value)) {
    if (fullText.length > maxStructuredChars) {
      response.structuredContent = {
        success: true,
        truncated: true,
        originalChars: fullText.length,
        message:
          "structuredContent omitted for large payload. Use text content preview or call with narrower filters.",
        keys: Object.keys(value).slice(0, 50),
      };
    } else {
      response.structuredContent = value;
    }
  }

  return response;
}

function errorResult(message: string, details?: unknown): CallToolResult {
  const payload: JsonObject = {
    success: false,
    error: message,
  };
  if (details !== undefined) {
    payload.details = details;
  }

  return {
    content: [{ type: TEXT_CONTENT, text: asJsonText(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function loginRequiredResult(message: string): CallToolResult {
  return {
    content: [{ type: TEXT_CONTENT, text: message }],
    structuredContent: {
      success: false,
      error: "login required",
      message,
      action: "render_login_form",
      form: {
        fields: [
          { name: "profileId", type: "text", label: "Profile ID (optional)" },
          { name: "username", type: "text", label: "Username" },
          { name: "password", type: "password", label: "Password" },
          { name: "url", type: "url", label: "Saviynt Base URL" },
        ],
      },
    },
    isError: true,
  };
}

function appendQuery(url: URL, query?: JsonObject): void {
  if (!query) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }

    url.searchParams.append(key, String(value));
  }
}

function getTokenCandidate(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const tokenKeys = [
    "access_token",
    "accessToken",
    "token",
    "bearerToken",
    "jwt",
    "jwtToken",
  ];

  for (const key of tokenKeys) {
    const directValue = asString(payload[key]);
    if (directValue) {
      return directValue;
    }
  }

  const nestedData = asObject(payload.data);
  if (!nestedData) {
    return undefined;
  }

  for (const key of tokenKeys) {
    const nestedValue = asString(nestedData[key]);
    if (nestedValue) {
      return nestedValue;
    }
  }

  return undefined;
}

function getTokenExpirySeconds(payload: unknown): number {
  const defaultExpirySeconds = 3600;

  if (!isRecord(payload)) {
    return defaultExpirySeconds;
  }

  const directCandidates = [
    payload.expiresIn,
    payload.expires_in,
    payload.expires,
  ];

  for (const candidate of directCandidates) {
    const numericValue = asNumber(candidate);
    if (numericValue && numericValue > 0) {
      return numericValue;
    }
  }

  const nestedData = asObject(payload.data);
  if (!nestedData) {
    return defaultExpirySeconds;
  }

  const nestedCandidates = [
    nestedData.expiresIn,
    nestedData.expires_in,
    nestedData.expires,
  ];

  for (const candidate of nestedCandidates) {
    const numericValue = asNumber(candidate);
    if (numericValue && numericValue > 0) {
      return numericValue;
    }
  }

  return defaultExpirySeconds;
}

function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return [];
  }

  const candidateKeys = [
    "requests",
    "items",
    "data",
    "pendingRequests",
    "pending_requests",
    "results",
  ];

  for (const key of candidateKeys) {
    const candidateValue = value[key];
    if (Array.isArray(candidateValue)) {
      return candidateValue;
    }
  }

  return [];
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const raw = await response.text();

  if (!raw.trim()) {
    return {};
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  if (raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

export function createSaviyntMcpServer(options: CreateSaviyntServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "saviynt-api-mcp",
      version: "2.1.0",
    },
    {
      capabilities: { logging: {} },
    }
  );

  const defaultBaseUrlRaw = asString(options.defaultBaseUrl || process.env.SAVIYNT_BASE_URL || "");
  const defaultBaseUrl = defaultBaseUrlRaw ? normalizeBaseUrl(defaultBaseUrlRaw) : undefined;
  const defaultApiPath = normalizeApiPath(asString(process.env.SAVIYNT_API_PATH) || "api/v5");
  const writesEnabled =
    options.enableWrites ?? process.env.SAVIYNT_ENABLE_WRITE?.toLowerCase() === "true";
  const serviceUsername = asString(
    process.env.SAVIYNT_SERVICE_USERNAME || process.env.SAVIYNT_USERNAME || ""
  );
  const servicePassword = asString(
    process.env.SAVIYNT_SERVICE_PASSWORD || process.env.SAVIYNT_PASSWORD || ""
  );

  const profiles = new Map<string, SaviyntProfileState>();
  const tokenCache = new Map<string, SaviyntTokenState>();
  let activeProfileId: string | null = null;
  const toolCallContext = new AsyncLocalStorage<{ profileId?: string }>();

  const getTokenCacheKey = (profileId: string, baseUrl: string): string =>
    `${profileId}::${normalizeBaseUrl(baseUrl)}`;

  const clearTokenCacheForProfile = (profileId: string): void => {
    for (const key of tokenCache.keys()) {
      if (key.startsWith(`${profileId}::`)) {
        tokenCache.delete(key);
      }
    }
  };

  const clearTokenCacheForProfileBaseUrl = (profileId: string, baseUrl: string): void => {
    tokenCache.delete(getTokenCacheKey(profileId, baseUrl));
  };

  const upsertProfile = (
    profile: Omit<SaviyntProfileState, "updatedAt">,
    setActive = true
  ): SaviyntProfileState => {
    const existing = profiles.get(profile.profileId);
    if (
      existing &&
      (existing.baseUrl !== profile.baseUrl ||
        existing.username !== profile.username ||
        existing.password !== profile.password)
    ) {
      clearTokenCacheForProfile(profile.profileId);
    }

    const next: SaviyntProfileState = {
      ...profile,
      updatedAt: Date.now(),
    };
    profiles.set(next.profileId, next);
    if (setActive) {
      activeProfileId = next.profileId;
    }
    return next;
  };

  const ensureAuthFromEnvironment = (preferredBaseUrl?: string): SaviyntProfileState | null => {
    if (!serviceUsername || !servicePassword) {
      return null;
    }

    const envBaseUrl = asString(preferredBaseUrl) || defaultBaseUrl;
    if (!envBaseUrl) {
      return null;
    }

    return upsertProfile(
      {
        profileId: ENV_PROFILE_ID,
        username: serviceUsername,
        password: servicePassword,
        baseUrl: normalizeBaseUrl(envBaseUrl),
        source: "env",
      },
      !activeProfileId
    );
  };

  const resolveExistingProfile = (requestedProfileId?: string): SaviyntProfileState | null => {
    const explicitProfileId = asString(requestedProfileId);
    if (explicitProfileId) {
      return profiles.get(explicitProfileId) || null;
    }

    if (activeProfileId) {
      const activeProfile = profiles.get(activeProfileId);
      if (activeProfile) {
        return activeProfile;
      }
      activeProfileId = null;
    }

    return null;
  };

  const ensureLoggedInProfile = (
    requestedProfileId?: string,
    preferredBaseUrl?: string
  ): SaviyntProfileState => {
    const explicitProfileId = asString(requestedProfileId);
    if (explicitProfileId) {
      const profile = profiles.get(explicitProfileId);
      if (profile) {
        return profile;
      }
      if (explicitProfileId === ENV_PROFILE_ID) {
        const envProfile = ensureAuthFromEnvironment(preferredBaseUrl);
        if (envProfile) {
          return envProfile;
        }
      }
      throw new LoginRequiredError(
        `Profile '${explicitProfileId}' was not found. Call saviynt_upsert_profile or saviynt_login first.`
      );
    }

    const existingProfile = resolveExistingProfile();
    if (existingProfile) {
      return existingProfile;
    }

    const envProfile = ensureAuthFromEnvironment(preferredBaseUrl);
    if (envProfile) {
      return envProfile;
    }

    throw new LoginRequiredError(
      "Login required before calling Saviynt tools. Use saviynt_upsert_profile/saviynt_login, or set SAVIYNT_SERVICE_USERNAME and SAVIYNT_SERVICE_PASSWORD."
    );
  };

  const resolveBaseUrl = (value?: string, profile?: SaviyntProfileState | null): string => {
    const fromArg = asString(value);
    if (fromArg) {
      return normalizeBaseUrl(fromArg);
    }

    if (profile?.baseUrl) {
      return profile.baseUrl;
    }

    if (defaultBaseUrl) {
      return defaultBaseUrl;
    }

    throw new Error(
      "Missing Saviynt base URL. Provide `url` in the tool call or set SAVIYNT_BASE_URL."
    );
  };

  const resolveProfileForRequest = (
    requestedProfileId?: string,
    preferredBaseUrl?: string
  ): SaviyntProfileState | null => {
    const explicitProfileId = asString(requestedProfileId);
    if (explicitProfileId) {
      const profile = profiles.get(explicitProfileId);
      if (profile) {
        return profile;
      }

      if (explicitProfileId === ENV_PROFILE_ID) {
        return ensureAuthFromEnvironment(preferredBaseUrl);
      }

      return null;
    }

    return resolveExistingProfile() || ensureAuthFromEnvironment(preferredBaseUrl);
  };

  const getProfileTokenState = (profile: SaviyntProfileState): SaviyntTokenState | null => {
    const key = getTokenCacheKey(profile.profileId, profile.baseUrl);
    return tokenCache.get(key) || null;
  };

  const getProfileSummary = (profile: SaviyntProfileState): JsonObject => {
    const tokenState = getProfileTokenState(profile);
    const tokenExpiresAt = tokenState?.tokenExpiresAt;
    const tokenValid = Boolean(tokenExpiresAt && Date.now() < tokenExpiresAt);

    return {
      profileId: profile.profileId,
      source: profile.source,
      username: profile.username,
      baseUrl: profile.baseUrl,
      active: profile.profileId === activeProfileId,
      hasToken: Boolean(tokenState?.bearerToken),
      tokenValid,
      tokenExpiresAt,
      updatedAt: profile.updatedAt,
    };
  };

  const ensureWritesEnabled = (toolName: string): void => {
    if (writesEnabled) {
      return;
    }
    throw new Error(
      `Write operations are disabled. Set SAVIYNT_ENABLE_WRITE=true to enable '${toolName}'.`
    );
  };

  const ensureBearerToken = async (
    forceRefresh = false,
    requestedProfileId?: string,
    preferredBaseUrl?: string
  ): Promise<string> => {
    const profile = ensureLoggedInProfile(requestedProfileId, preferredBaseUrl);
    const baseUrl = resolveBaseUrl(preferredBaseUrl, profile);
    const cacheKey = getTokenCacheKey(profile.profileId, baseUrl);
    const cachedToken = tokenCache.get(cacheKey);

    if (!forceRefresh && cachedToken?.bearerToken && cachedToken.tokenExpiresAt) {
      if (Date.now() < cachedToken.tokenExpiresAt) {
        return cachedToken.bearerToken;
      }
      tokenCache.delete(cacheKey);
    }

    const attempts: string[] = [];
    const payloadCandidates: JsonObject[] = [
      { username: profile.username, password: profile.password },
      { username: profile.username, password: profile.password, grant_type: "password" },
    ];

    for (const endpoint of LOGIN_ENDPOINTS) {
      for (const payload of payloadCandidates) {
        const requestUrl = new URL(endpoint, baseUrl);
        const response = await fetch(requestUrl.toString(), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const parsedBody = await parseResponseBody(response);
        if (!response.ok) {
          attempts.push(`${endpoint} -> ${response.status} ${response.statusText}`);
          continue;
        }

        const token = getTokenCandidate(parsedBody);
        if (!token) {
          attempts.push(`${endpoint} -> success response but no token field`);
          continue;
        }

        const expiresInSeconds = getTokenExpirySeconds(parsedBody);
        const refreshSeconds = Math.max(30, Math.floor(expiresInSeconds * 0.92));
        tokenCache.set(cacheKey, {
          bearerToken: token,
          tokenExpiresAt: Date.now() + refreshSeconds * 1000,
        });
        activeProfileId = profile.profileId;
        return token;
      }
    }

    throw new Error(
      `Unable to authenticate profile '${profile.profileId}' with Saviynt. Attempts: ${attempts.join(" | ")}`
    );
  };

  const callSaviyntApi = async (opts: ApiRequestOptions): Promise<unknown> => {
    const contextProfileId = toolCallContext.getStore()?.profileId;
    const requestedProfileId = asString(opts.profileId) || contextProfileId;
    const method = opts.method || "GET";
    const requiresAuth = opts.requiresAuth ?? true;
    const retryOnUnauthorized = opts.retryOnUnauthorized ?? true;
    const profile = requiresAuth
      ? ensureLoggedInProfile(requestedProfileId, opts.baseUrl)
      : resolveProfileForRequest(requestedProfileId, opts.baseUrl);
    if (requestedProfileId && !profile) {
      throw new LoginRequiredError(
        `Profile '${requestedProfileId}' was not found. Call saviynt_upsert_profile or saviynt_login first.`
      );
    }
    const baseUrl = resolveBaseUrl(opts.baseUrl, profile);

    const url = new URL(opts.endpoint, baseUrl);
    appendQuery(url, opts.query);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (requiresAuth) {
      const token = await ensureBearerToken(false, profile?.profileId, baseUrl);
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (response.status === 401 && retryOnUnauthorized && requiresAuth) {
      if (profile) {
        clearTokenCacheForProfileBaseUrl(profile.profileId, baseUrl);
      }
      await ensureBearerToken(true, profile?.profileId, baseUrl);
      return callSaviyntApi({
        ...opts,
        baseUrl,
        profileId: profile?.profileId,
        retryOnUnauthorized: false,
      });
    }

    const parsedBody = await parseResponseBody(response);
    if (!response.ok) {
      const detailText =
        typeof parsedBody === "string" ? parsedBody : asJsonText(parsedBody);
      throw new Error(
        `Saviynt API error ${response.status} ${response.statusText}: ${truncate(detailText)}`
      );
    }

    return parsedBody;
  };

  const profileIdInputSchema = z
    .string()
    .min(1)
    .optional()
    .describe("Optional auth profile ID. If omitted, the active profile is used.");

  const registerTool = (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    handler: (args: JsonObject) => Promise<CallToolResult>,
    options: { includeProfileId?: boolean } = {}
  ): void => {
    const includeProfileId = options.includeProfileId ?? true;
    const schemaWithProfileId =
      includeProfileId && !Object.prototype.hasOwnProperty.call(inputSchema, "profileId")
        ? { ...inputSchema, profileId: profileIdInputSchema }
        : inputSchema;

    server.registerTool(
      name,
      {
        description,
        inputSchema: schemaWithProfileId,
      },
      async (args) => {
        const parsedArgs = args as JsonObject;
        return toolCallContext.run({ profileId: asString(parsedArgs.profileId) }, async () => {
          try {
            return await handler(parsedArgs);
          } catch (error) {
            if (error instanceof LoginRequiredError) {
              return loginRequiredResult(error.message);
            }
            return errorResult(`Tool '${name}' failed`, toErrorMessage(error));
          }
        });
      }
    );
  };

  const loginHandler = async (args: JsonObject): Promise<CallToolResult> => {
    const username = asString(args.username);
    const password = asString(args.password);
    const providedUrl = asString(args.url);
    const requestedProfileId = asString(args.profileId) || activeProfileId || DEFAULT_PROFILE_ID;
    const setActive = asBoolean(args.setActive) ?? true;

    if (!username || !password) {
      return errorResult("Both 'username' and 'password' are required.");
    }

    const existingProfile = profiles.get(requestedProfileId);
    const resolvedBaseUrl = normalizeBaseUrl(
      providedUrl || existingProfile?.baseUrl || defaultBaseUrl || ""
    );
    if (!resolvedBaseUrl) {
      return errorResult(
        "Missing Saviynt base URL. Provide 'url' or set SAVIYNT_BASE_URL in the environment."
      );
    }

    const profile = upsertProfile(
      {
        profileId: requestedProfileId,
        username,
        password,
        baseUrl: resolvedBaseUrl,
        source: "session",
      },
      setActive
    );

    const token = await ensureBearerToken(true, profile.profileId, profile.baseUrl);
    const tokenState = getProfileTokenState(profile);
    return okResult({
      success: true,
      authenticated: true,
      profileId: profile.profileId,
      username,
      baseUrl: resolvedBaseUrl,
      activeProfileId,
      setActive,
      hasToken: Boolean(token),
      tokenExpiresAt: tokenState?.tokenExpiresAt,
    });
  };

  const profileStatusHandler = async (): Promise<CallToolResult> => {
    ensureAuthFromEnvironment();

    const profilesList = Array.from(profiles.values())
      .sort((a, b) => a.profileId.localeCompare(b.profileId))
      .map((profile) => getProfileSummary(profile));

    if (profilesList.length === 0) {
      return okResult({
        authenticated: false,
        profileCount: 0,
        activeProfileId: null,
        message:
          "No profiles configured. Call saviynt_upsert_profile/saviynt_login or set SAVIYNT_SERVICE_USERNAME and SAVIYNT_SERVICE_PASSWORD.",
      });
    }

    const activeProfile =
      (activeProfileId && profiles.get(activeProfileId)) || profiles.get(ENV_PROFILE_ID) || null;
    if (activeProfile && activeProfile.profileId !== activeProfileId) {
      activeProfileId = activeProfile.profileId;
    }

    return okResult({
      authenticated: true,
      profileCount: profilesList.length,
      activeProfileId,
      profiles: profilesList,
    });
  };

  registerTool(
    "saviynt_upsert_profile",
    "Create or update a Saviynt auth profile and optionally authenticate it now.",
    {
      profileId: z.string().min(1).optional().describe(`Default: ${DEFAULT_PROFILE_ID}`),
      username: z.string().min(1).describe("Saviynt username"),
      password: z.string().min(1).describe("Saviynt password"),
      url: z.string().url().describe("Saviynt base URL"),
      setActive: z.boolean().optional().describe("Default: true"),
      authenticate: z.boolean().optional().describe("Default: true"),
    },
    async (args) => {
      const profileId = asString(args.profileId) || activeProfileId || DEFAULT_PROFILE_ID;
      const username = asString(args.username);
      const password = asString(args.password);
      const url = asString(args.url);
      const setActive = asBoolean(args.setActive) ?? true;
      const authenticate = asBoolean(args.authenticate) ?? true;

      if (!username || !password || !url) {
        return errorResult("Arguments 'username', 'password', and 'url' are required.");
      }

      const profile = upsertProfile(
        {
          profileId,
          username,
          password,
          baseUrl: normalizeBaseUrl(url),
          source: "session",
        },
        setActive
      );

      if (authenticate) {
        await ensureBearerToken(true, profile.profileId, profile.baseUrl);
      } else {
        clearTokenCacheForProfileBaseUrl(profile.profileId, profile.baseUrl);
      }

      return okResult({
        success: true,
        profile: getProfileSummary(profile),
        authenticatedNow: authenticate,
      });
    },
    { includeProfileId: false }
  );

  registerTool(
    "saviynt_login",
    "Compatibility auth helper that creates/updates a profile and authenticates it.",
    {
      profileId: z.string().min(1).optional().describe(`Default: ${DEFAULT_PROFILE_ID}`),
      username: z.string().min(1).describe("Saviynt username"),
      password: z.string().min(1).describe("Saviynt password"),
      url: z.string().url().optional().describe("Saviynt base URL"),
      setActive: z.boolean().optional().describe("Default: true"),
    },
    loginHandler,
    { includeProfileId: false }
  );

  registerTool(
    "login",
    "Compatibility alias for saviynt_login.",
    {
      profileId: z.string().min(1).optional(),
      username: z.string().min(1).describe("Saviynt username"),
      password: z.string().min(1).describe("Saviynt password"),
      url: z.string().url().optional().describe("Saviynt base URL"),
      setActive: z.boolean().optional(),
    },
    loginHandler,
    { includeProfileId: false }
  );

  registerTool(
    "saviynt_set_active_profile",
    "Set the active profile for calls that omit profileId.",
    {
      profileId: z.string().min(1),
    },
    async (args) => {
      const profileId = asString(args.profileId);
      if (!profileId) {
        return errorResult("Missing required argument: profileId");
      }

      const profile =
        profiles.get(profileId) ||
        (profileId === ENV_PROFILE_ID ? ensureAuthFromEnvironment() : null);
      if (!profile) {
        return errorResult(
          `Profile '${profileId}' does not exist. Call saviynt_upsert_profile or saviynt_login first.`
        );
      }

      activeProfileId = profile.profileId;
      return okResult({
        success: true,
        activeProfileId,
        profile: getProfileSummary(profile),
      });
    },
    { includeProfileId: false }
  );

  registerTool(
    "saviynt_list_profiles",
    "List configured auth profiles and token state.",
    {},
    async () => profileStatusHandler(),
    { includeProfileId: false }
  );

  registerTool(
    "saviynt_delete_profile",
    "Delete a profile and all cached tokens for that profile.",
    {
      profileId: z.string().min(1),
    },
    async (args) => {
      const profileId = asString(args.profileId);
      if (!profileId) {
        return errorResult("Missing required argument: profileId");
      }

      if (!profiles.has(profileId)) {
        return errorResult(`Profile '${profileId}' does not exist.`);
      }

      profiles.delete(profileId);
      clearTokenCacheForProfile(profileId);

      if (activeProfileId === profileId) {
        activeProfileId = null;
        ensureAuthFromEnvironment();
      }

      return okResult({
        success: true,
        deletedProfileId: profileId,
        activeProfileId,
      });
    },
    { includeProfileId: false }
  );

  registerTool(
    "saviynt_get_token_status",
    "Return profile and token state for this MCP session.",
    {},
    async () => profileStatusHandler(),
    { includeProfileId: false }
  );

  registerTool(
    "get_token_status",
    "Compatibility alias for saviynt_get_token_status.",
    {},
    async () => profileStatusHandler(),
    { includeProfileId: false }
  );

  registerTool(
    "saviynt_query_identities",
    "Query identities/users from Saviynt.",
    {
      query: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getIdentities",
        method: "POST",
        body: {
          query: asString(args.query) || "",
          limit: asNumber(args.limit) || 50,
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_get_user_profile",
    "Fetch a single user profile.",
    {
      userId: z.string().min(1),
    },
    async (args) => {
      const userId = asString(args.userId);
      if (!userId) {
        return errorResult("Missing required argument: userId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getUser",
        method: "POST",
        body: { userId },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_search_users",
    "Search users with optional filters.",
    {
      query: z.string().optional(),
      department: z.string().optional(),
      status: z.string().optional(),
      role: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/searchUsers",
        method: "POST",
        body: {
          query: asString(args.query),
          department: asString(args.department),
          status: asString(args.status),
          role: asString(args.role),
          limit: asNumber(args.limit),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_get_accounts",
    "Get accounts by identity/user.",
    {
      identityId: z.string().min(1),
      applicationId: z.string().optional(),
    },
    async (args) => {
      const identityId = asString(args.identityId);
      if (!identityId) {
        return errorResult("Missing required argument: identityId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getAccounts",
        method: "POST",
        body: {
          identityId,
          applicationId: asString(args.applicationId),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_get_entitlements",
    "Get entitlements by identity/user.",
    {
      identityId: z.string().min(1),
      applicationId: z.string().optional(),
    },
    async (args) => {
      const identityId = asString(args.identityId);
      if (!identityId) {
        return errorResult("Missing required argument: identityId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getEntitlements",
        method: "POST",
        body: {
          identityId,
          applicationId: asString(args.applicationId),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_search_access_requests",
    "List/search access requests.",
    {
      status: z.string().optional(),
      requestor: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/listAccessRequests",
        method: "POST",
        body: {
          status: asString(args.status),
          requestor: asString(args.requestor),
          limit: asNumber(args.limit),
          offset: asNumber(args.offset),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_list_applications",
    "List applications configured in Saviynt.",
    {
      searchText: z.string().optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/listApplications",
        method: "POST",
        body: {
          searchText: asString(args.searchText),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_list_endpoints",
    "List security systems/endpoints.",
    {
      searchText: z.string().optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/listEndpoints",
        method: "POST",
        body: {
          searchText: asString(args.searchText),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_search_security_systems",
    "Search security systems/endpoints.",
    {
      searchText: z.string().optional(),
      type: z.string().optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/searchSecuritySystems",
        method: "POST",
        body: {
          searchText: asString(args.searchText),
          type: asString(args.type),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_get_accounts_import_details",
    "Get account import details/jobs for an endpoint.",
    {
      endpointId: z.string().min(1),
      applicationId: z.string().optional(),
    },
    async (args) => {
      const endpointId = asString(args.endpointId);
      if (!endpointId) {
        return errorResult("Missing required argument: endpointId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getEndpointImportJobs",
        method: "POST",
        body: {
          endpointId,
          applicationId: asString(args.applicationId),
          importType: "accounts",
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_get_access_import_details",
    "Get access import details/jobs for an endpoint.",
    {
      endpointId: z.string().min(1),
      applicationId: z.string().optional(),
    },
    async (args) => {
      const endpointId = asString(args.endpointId);
      if (!endpointId) {
        return errorResult("Missing required argument: endpointId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getEndpointImportJobs",
        method: "POST",
        body: {
          endpointId,
          applicationId: asString(args.applicationId),
          importType: "access",
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_get_import_job_status",
    "Get import job status by job ID.",
    {
      jobId: z.string().min(1),
    },
    async (args) => {
      const jobId = asString(args.jobId);
      if (!jobId) {
        return errorResult("Missing required argument: jobId");
      }

      const result = await callSaviyntApi({
        endpoint: `/ECM/api/jobs/${encodeURIComponent(jobId)}`,
        method: "GET",
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_get_audit_log",
    "Query audit log entries.",
    {
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      action: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().positive().max(5000).optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/auditLog",
        method: "POST",
        body: {
          entityType: asString(args.entityType),
          entityId: asString(args.entityId),
          action: asString(args.action),
          startDate: asString(args.startDate),
          endDate: asString(args.endDate),
          limit: asNumber(args.limit),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_get_system_config",
    "Get Saviynt configuration values.",
    {
      configKey: z.string().optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/config",
        method: "GET",
        query: {
          configKey: asString(args.configKey),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_list_roles",
    "List roles.",
    {
      searchText: z.string().optional(),
      limit: z.number().int().positive().max(5000).optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/roles",
        method: "GET",
        query: {
          searchText: asString(args.searchText),
          limit: asNumber(args.limit),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_list_campaigns",
    "List campaigns.",
    {
      status: z.string().optional(),
      limit: z.number().int().positive().max(5000).optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/listCampaigns",
        method: "POST",
        body: {
          status: asString(args.status),
          limit: asNumber(args.limit),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "get_users",
    "Compatibility alias for listing/querying users.",
    {
      query: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    async (args) => {
      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getIdentities",
        method: "POST",
        body: {
          query: asString(args.query) || "",
          limit: asNumber(args.limit) || 50,
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "get_user_accounts",
    "Compatibility alias for user account lookup.",
    {
      userId: z.string().min(1),
      applicationId: z.string().optional(),
    },
    async (args) => {
      const userId = asString(args.userId);
      if (!userId) {
        return errorResult("Missing required argument: userId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getAccounts",
        method: "POST",
        body: {
          identityId: userId,
          applicationId: asString(args.applicationId),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "get_user_entitlements",
    "Compatibility alias for user entitlement lookup.",
    {
      userId: z.string().min(1),
      applicationId: z.string().optional(),
    },
    async (args) => {
      const userId = asString(args.userId);
      if (!userId) {
        return errorResult("Missing required argument: userId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/getEntitlements",
        method: "POST",
        body: {
          identityId: userId,
          applicationId: asString(args.applicationId),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "get_user_roles",
    "Compatibility helper that extracts role info from user profile response.",
    {
      userId: z.string().min(1),
    },
    async (args) => {
      const userId = asString(args.userId);
      if (!userId) {
        return errorResult("Missing required argument: userId");
      }

      const profile = await callSaviyntApi({
        endpoint: "/ECM/api/getUser",
        method: "POST",
        body: { userId },
      });

      const roles = extractArray(profile);
      return okResult({
        userId,
        roles,
        raw: profile,
      });
    }
  );

  registerTool(
    "get_user_endpoints",
    "Compatibility helper for endpoint lookup.",
    {
      userId: z.string().min(1),
      searchText: z.string().optional(),
    },
    async (args) => {
      const userId = asString(args.userId);
      if (!userId) {
        return errorResult("Missing required argument: userId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/listEndpoints",
        method: "POST",
        body: {
          searchText: asString(args.searchText) || userId,
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "get_complete_access_path",
    "Compatibility helper returning user + account + entitlement data together.",
    {
      userId: z.string().min(1),
      applicationId: z.string().optional(),
    },
    async (args) => {
      const userId = asString(args.userId);
      if (!userId) {
        return errorResult("Missing required argument: userId");
      }
      const applicationId = asString(args.applicationId);

      const profileResult = await callSaviyntApi({
        endpoint: "/ECM/api/getUser",
        method: "POST",
        body: { userId },
      });
      const accountResult = await callSaviyntApi({
        endpoint: "/ECM/api/getAccounts",
        method: "POST",
        body: { identityId: userId, applicationId },
      });
      const entitlementResult = await callSaviyntApi({
        endpoint: "/ECM/api/getEntitlements",
        method: "POST",
        body: { identityId: userId, applicationId },
      });

      return okResult({
        userId,
        profile: profileResult,
        accounts: accountResult,
        entitlements: entitlementResult,
      });
    }
  );

  registerTool(
    "get_list_of_pending_requests_for_approver",
    "Compatibility tool for pending request workflows.",
    {
      max: z.number().int().positive().max(500).optional(),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().min(0).optional(),
      status: z.string().optional(),
    },
    async (args) => {
      const limit = asNumber(args.max) || asNumber(args.limit) || 10;
      const status = asString(args.status) || "PENDING";

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/listAccessRequests",
        method: "POST",
        body: {
          status,
          limit,
          offset: asNumber(args.offset) || 0,
        },
      });

      const requests = extractArray(result);
      return okResult({
        success: true,
        requests,
        count: requests.length,
        raw: result,
      });
    }
  );

  registerTool(
    "saviynt_create_access_request",
    "Create a new access request.",
    {
      identityId: z.string().min(1),
      applicationId: z.string().min(1),
      entitlementIds: z.array(z.string()).min(1),
      justification: z.string().optional(),
    },
    async (args) => {
      ensureWritesEnabled("saviynt_create_access_request");
      const body = {
        identityId: asString(args.identityId),
        applicationId: asString(args.applicationId),
        entitlementIds: Array.isArray(args.entitlementIds) ? args.entitlementIds : [],
        justification: asString(args.justification),
      };

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/createAccessRequest",
        method: "POST",
        body,
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_approve_request",
    "Approve an access request.",
    {
      requestId: z.string().min(1),
      approverComments: z.string().optional(),
    },
    async (args) => {
      ensureWritesEnabled("saviynt_approve_request");
      const requestId = asString(args.requestId);
      if (!requestId) {
        return errorResult("Missing required argument: requestId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/approveAccessRequest",
        method: "POST",
        body: {
          requestId,
          approverComments: asString(args.approverComments),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_reject_request",
    "Reject an access request.",
    {
      requestId: z.string().min(1),
      rejectionReason: z.string().optional(),
    },
    async (args) => {
      ensureWritesEnabled("saviynt_reject_request");
      const requestId = asString(args.requestId);
      if (!requestId) {
        return errorResult("Missing required argument: requestId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/rejectAccessRequest",
        method: "POST",
        body: {
          requestId,
          rejectionReason: asString(args.rejectionReason),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "saviynt_revoke_access",
    "Revoke previously granted access.",
    {
      accountId: z.string().min(1),
      entitlementIds: z.array(z.string()).optional(),
      reason: z.string().optional(),
    },
    async (args) => {
      ensureWritesEnabled("saviynt_revoke_access");
      const accountId = asString(args.accountId);
      if (!accountId) {
        return errorResult("Missing required argument: accountId");
      }

      const result = await callSaviyntApi({
        endpoint: "/ECM/api/revokeAccessRequest",
        method: "POST",
        body: {
          accountId,
          entitlementIds: Array.isArray(args.entitlementIds) ? args.entitlementIds : [],
          reason: asString(args.reason),
        },
      });
      return okResult(result);
    }
  );

  registerTool(
    "approve_reject_entire_request",
    "Compatibility write tool used by access review UIs.",
    {
      requestId: z.string().optional(),
      requestid: z.string().optional(),
      requestKey: z.string().optional(),
      requestkey: z.string().optional(),
      action: z.string().optional(),
      decision: z.string().optional(),
      status: z.string().optional(),
      comments: z.string().optional(),
      approverComments: z.string().optional(),
      rejectionReason: z.string().optional(),
      reason: z.string().optional(),
    },
    async (args) => {
      ensureWritesEnabled("approve_reject_entire_request");

      const requestId =
        asString(args.requestId) ||
        asString(args.requestid) ||
        asString(args.requestKey) ||
        asString(args.requestkey);
      if (!requestId) {
        return errorResult("Missing request ID/key. Provide requestId or requestKey.");
      }

      const rawDecision =
        asString(args.action) || asString(args.decision) || asString(args.status) || "approve";
      const decision = rawDecision.toLowerCase().includes("reject") ? "reject" : "approve";
      const comment =
        asString(args.comments) ||
        asString(args.approverComments) ||
        asString(args.rejectionReason) ||
        asString(args.reason);

      const endpoint =
        decision === "approve" ? "/ECM/api/approveAccessRequest" : "/ECM/api/rejectAccessRequest";
      const result = await callSaviyntApi({
        endpoint,
        method: "POST",
        body: {
          requestId,
          requestKey: requestId,
          action: decision,
          approverComments: decision === "approve" ? comment : undefined,
          rejectionReason: decision === "reject" ? comment : undefined,
          comments: comment,
        },
      });

      return okResult({
        decision,
        requestId,
        result,
      });
    }
  );

  const passthroughObject = z.object({}).passthrough();

  const resolveApiPath = (value?: string): string => {
    const fromArg = asString(value);
    return normalizeApiPath(fromArg || defaultApiPath);
  };

  const runV5WriteTool = async (
    toolName: string,
    method: HttpMethod,
    operationPath: string,
    args: JsonObject
  ): Promise<CallToolResult> => {
    ensureWritesEnabled(toolName);

    const apiPath = resolveApiPath(asString(args.apiPath));
    const endpoint = `/ECM/${apiPath}/${operationPath}`;

    const result = await callSaviyntApi({
      endpoint,
      method,
      query: asObject(args.params),
      body: asObject(args.payload),
      baseUrl: asString(args.url),
      requiresAuth: true,
    });

    return okResult({
      success: true,
      tool: toolName,
      method,
      endpoint,
      result,
    });
  };

  const registerV5WriteTool = (
    name: string,
    description: string,
    method: HttpMethod,
    operationPath: string
  ): void => {
    registerTool(
      name,
      description,
      {
        payload: passthroughObject
          .optional()
          .describe("JSON request body exactly as required by your Saviynt endpoint"),
        params: passthroughObject.optional().describe("Optional query parameters"),
        apiPath: z
          .string()
          .optional()
          .describe("Optional API path override. Default: api/v5"),
        url: z.string().url().optional().describe("Optional base URL override"),
      },
      async (args) => runV5WriteTool(name, method, operationPath, args)
    );
  };

  // Typed v5 write wrappers from Saviynt API Reference (Chicago release).
  registerV5WriteTool("saviynt_create_user", "Create user via /createUser.", "POST", "createUser");
  registerV5WriteTool("saviynt_update_user", "Update user via /updateUser.", "POST", "updateUser");
  registerV5WriteTool(
    "saviynt_create_account",
    "Create account via /createAccount.",
    "POST",
    "createAccount"
  );
  registerV5WriteTool(
    "saviynt_update_account",
    "Update account via /updateAccount.",
    "POST",
    "updateAccount"
  );
  registerV5WriteTool("saviynt_add_role", "Add role via /addrole.", "POST", "addrole");
  registerV5WriteTool("saviynt_remove_role", "Remove role via /removerole.", "POST", "removerole");
  registerV5WriteTool(
    "saviynt_create_endpoint",
    "Create endpoint via /createEndpoint.",
    "POST",
    "createEndpoint"
  );
  registerV5WriteTool(
    "saviynt_update_endpoint",
    "Update endpoint via /updateEndpoint.",
    "PUT",
    "updateEndpoint"
  );
  registerV5WriteTool(
    "saviynt_create_security_system",
    "Create security system via /createSecuritySystem.",
    "POST",
    "createSecuritySystem"
  );
  registerV5WriteTool(
    "saviynt_update_security_system",
    "Update security system via /updateSecuritySystem.",
    "PUT",
    "updateSecuritySystem"
  );
  registerV5WriteTool(
    "saviynt_create_organization",
    "Create organization via /createOrganization.",
    "POST",
    "createOrganization"
  );
  registerV5WriteTool(
    "saviynt_update_organization",
    "Update organization via /updateOrganization.",
    "PUT",
    "updateOrganization"
  );
  registerV5WriteTool(
    "saviynt_delete_organization",
    "Delete organization via /deleteOrganization.",
    "POST",
    "deleteOrganization"
  );
  registerV5WriteTool(
    "saviynt_create_update_entitlement",
    "Create or update entitlement via /createUpdateEntitlement.",
    "POST",
    "createUpdateEntitlement"
  );
  registerV5WriteTool(
    "saviynt_create_entitlement_type",
    "Create entitlement type via /createEntitlementType.",
    "POST",
    "createEntitlementType"
  );
  registerV5WriteTool(
    "saviynt_update_entitlement_type",
    "Update entitlement type via /updateEntitlementType.",
    "PUT",
    "updateEntitlementType"
  );
  registerV5WriteTool(
    "saviynt_create_update_user_group",
    "Create or update user group via /createUpdateUserGroup.",
    "POST",
    "createUpdateUserGroup"
  );
  registerV5WriteTool(
    "saviynt_delete_user_group",
    "Delete user group via /deleteUserGroup.",
    "POST",
    "deleteUserGroup"
  );
  registerV5WriteTool(
    "saviynt_create_dataset",
    "Create dataset via /createDataset.",
    "POST",
    "createDataset"
  );
  registerV5WriteTool(
    "saviynt_update_dataset",
    "Update dataset via /updateDataset.",
    "POST",
    "updateDataset"
  );
  registerV5WriteTool(
    "saviynt_delete_dataset",
    "Delete dataset via /deleteDataset.",
    "POST",
    "deleteDataset"
  );

  const createResourceHandler = async (args: JsonObject): Promise<CallToolResult> => {
    ensureWritesEnabled("saviynt_create_resource");

    const endpoint = asString(args.endpoint);
    if (!endpoint) {
      return errorResult("Missing required argument: endpoint");
    }

    const result = await callSaviyntApi({
      endpoint,
      method: "POST",
      query: asObject(args.params),
      body: asObject(args.body),
      baseUrl: asString(args.url),
      requiresAuth: true,
    });

    return okResult({
      success: true,
      operation: "create",
      endpoint,
      result,
    });
  };

  const modifyResourceHandler = async (args: JsonObject): Promise<CallToolResult> => {
    ensureWritesEnabled("saviynt_modify_resource");

    const endpoint = asString(args.endpoint);
    if (!endpoint) {
      return errorResult("Missing required argument: endpoint");
    }

    const methodRaw = asString(args.method)?.toUpperCase();
    const method: HttpMethod =
      methodRaw === "PUT" || methodRaw === "PATCH" || methodRaw === "POST"
        ? (methodRaw as HttpMethod)
        : "PATCH";

    const result = await callSaviyntApi({
      endpoint,
      method,
      query: asObject(args.params),
      body: asObject(args.body),
      baseUrl: asString(args.url),
      requiresAuth: true,
    });

    return okResult({
      success: true,
      operation: "modify",
      method,
      endpoint,
      result,
    });
  };

  const deleteResourceHandler = async (args: JsonObject): Promise<CallToolResult> => {
    ensureWritesEnabled("saviynt_delete_resource");

    const endpoint = asString(args.endpoint);
    if (!endpoint) {
      return errorResult("Missing required argument: endpoint");
    }

    const methodRaw = asString(args.method)?.toUpperCase();
    const method: HttpMethod = methodRaw === "POST" ? "POST" : "DELETE";

    const result = await callSaviyntApi({
      endpoint,
      method,
      query: asObject(args.params),
      body: asObject(args.body),
      baseUrl: asString(args.url),
      requiresAuth: true,
    });

    return okResult({
      success: true,
      operation: "delete",
      method,
      endpoint,
      result,
    });
  };

  registerTool(
    "saviynt_create_resource",
    "Generic create operation using POST to a Saviynt endpoint.",
    {
      endpoint: z.string().min(1).describe("Saviynt endpoint path, e.g. /ECM/api/yourCreateEndpoint"),
      body: passthroughObject.optional().describe("Request payload"),
      params: passthroughObject.optional().describe("Optional query parameters"),
      url: z.string().url().optional().describe("Optional base URL override"),
    },
    createResourceHandler
  );

  registerTool(
    "create_resource",
    "Compatibility alias for saviynt_create_resource.",
    {
      endpoint: z.string().min(1),
      body: passthroughObject.optional(),
      params: passthroughObject.optional(),
      url: z.string().url().optional(),
    },
    createResourceHandler
  );

  registerTool(
    "saviynt_modify_resource",
    "Generic modify operation using PATCH/PUT/POST to a Saviynt endpoint.",
    {
      endpoint: z.string().min(1).describe("Saviynt endpoint path"),
      method: z.enum(["PATCH", "PUT", "POST"]).optional().describe("Default: PATCH"),
      body: passthroughObject.optional().describe("Request payload"),
      params: passthroughObject.optional().describe("Optional query parameters"),
      url: z.string().url().optional().describe("Optional base URL override"),
    },
    modifyResourceHandler
  );

  registerTool(
    "modify_resource",
    "Compatibility alias for saviynt_modify_resource.",
    {
      endpoint: z.string().min(1),
      method: z.enum(["PATCH", "PUT", "POST"]).optional(),
      body: passthroughObject.optional(),
      params: passthroughObject.optional(),
      url: z.string().url().optional(),
    },
    modifyResourceHandler
  );

  registerTool(
    "saviynt_delete_resource",
    "Generic delete operation using DELETE (or POST if required by target endpoint).",
    {
      endpoint: z.string().min(1).describe("Saviynt endpoint path"),
      method: z.enum(["DELETE", "POST"]).optional().describe("Default: DELETE"),
      params: passthroughObject.optional().describe("Optional query parameters"),
      body: passthroughObject.optional().describe("Optional request payload"),
      url: z.string().url().optional().describe("Optional base URL override"),
    },
    deleteResourceHandler
  );

  registerTool(
    "delete_resource",
    "Compatibility alias for saviynt_delete_resource.",
    {
      endpoint: z.string().min(1),
      method: z.enum(["DELETE", "POST"]).optional(),
      params: passthroughObject.optional(),
      body: passthroughObject.optional(),
      url: z.string().url().optional(),
    },
    deleteResourceHandler
  );

  const rawRequestHandler = async (args: JsonObject): Promise<CallToolResult> => {
    const endpoint = asString(args.endpoint);
    if (!endpoint) {
      return errorResult("Missing required argument: endpoint");
    }

    const methodRaw = asString(args.method)?.toUpperCase() || "GET";
    const method = (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodRaw)
      ? methodRaw
      : "GET") as HttpMethod;

    if (WRITE_METHODS.has(method)) {
      ensureWritesEnabled("raw_request");
    }

    const endpointLower = endpoint.toLowerCase();
    const authOptionalPath = endpointLower.includes("/login") || endpointLower.includes("/token");
    const requiresAuth = !authOptionalPath;

    const result = await callSaviyntApi({
      endpoint,
      method,
      query: asObject(args.params),
      body: asObject(args.body),
      baseUrl: asString(args.url),
      profileId: asString(args.profileId),
      requiresAuth,
    });

    return okResult(result);
  };

  registerTool(
    "saviynt_raw_request",
    "Raw Saviynt API request for custom endpoints.",
    {
      endpoint: z.string().min(1),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      params: passthroughObject.optional(),
      body: passthroughObject.optional(),
      url: z.string().url().optional(),
    },
    rawRequestHandler
  );

  registerTool(
    "raw_request",
    "Compatibility alias for saviynt_raw_request.",
    {
      endpoint: z.string().min(1),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      params: passthroughObject.optional(),
      body: passthroughObject.optional(),
      url: z.string().url().optional(),
    },
    rawRequestHandler
  );

  return server;
}
