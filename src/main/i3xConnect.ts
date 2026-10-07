import type { Constants, StudioProApi } from "@mendix/extensions-api";
import type { AuthConfig, ConnectionConfig } from "../ui/types/connection";
import {
    CONSTANT_API_BASE_URL,
    CONSTANT_API_PASSWORD,
    CONSTANT_API_TOKEN,
    CONSTANT_API_USERNAME,
    IMPLEMENTATION_MODULE,
} from "../ui/constants";
import { deriveEndpointFolderName } from "../ui/services/endpointConfiguration";
import { getApiBaseUrl } from "../ui/services/i3xUrl";

const AUTH_MODES = ["none", "basic", "token"] as const;
type AuthMode = typeof AUTH_MODES[number];

export interface ConnectInput {
    server: string | null;
    auth: AuthMode | null;
    tokenHeaderName: string | null;
    tokenPrefix: string | null;
}

// The same names the generators create, so a connection made here reuses the constants
// instead of creating new ones and asking the user to prefill them.
export const CONSTANT_NAMING_HELP =
    `Constants live in the ${IMPLEMENTATION_MODULE} module, as String constants. ` +
    `Single server: ${CONSTANT_API_BASE_URL} (the server URL), plus ${CONSTANT_API_TOKEN} for token auth, ` +
    `or ${CONSTANT_API_USERNAME} and ${CONSTANT_API_PASSWORD} for basic auth, in the folder ${IMPLEMENTATION_MODULE}/Configuration. ` +
    `Several servers: the same names with the suffix _<server>, for example ${CONSTANT_API_BASE_URL}_<server> and ` +
    `${CONSTANT_API_TOKEN}_<server>, in the folder ${IMPLEMENTATION_MODULE}/<server>/Configuration. ` +
    "<server> must be derived from the server URL: host, then _port if there is one, then the URL path, with every " +
    "character other than a letter, digit or underscore replaced by _, repeated underscores collapsed, and leading " +
    "or trailing underscores removed. For example, http://10.0.0.5:8885/i3x gives 10_0_0_5_8885_i3x. " +
    "Leave out the auth constants when the server needs no authentication.";

function withSuffix(name: string, suffix: string): string {
    return suffix ? `${name}_${suffix}` : name;
}

// Accepts a server name as it appears in the constant names, or a URL to derive it from.
function toServerSuffix(server: string): string {
    if (/^https?:\/\//i.test(server)) {
        const baseUrl = getApiBaseUrl(server);
        if (!baseUrl) throw new Error(`Cannot read a server URL from '${server}'.`);
        return deriveEndpointFolderName(baseUrl);
    }
    return server;
}

async function loadModuleConstants(sp: StudioProApi): Promise<Map<string, string>> {
    const ids = new Set((await sp.app.model.constants.getUnitsInfo())
        .filter(unit => unit.moduleName === IMPLEMENTATION_MODULE && unit.name?.startsWith("API_"))
        .map(unit => unit.$ID));
    if (ids.size === 0) return new Map();
    const constants: Constants.Constant[] = await sp.app.model.constants.loadAll(unit => ids.has(unit.$ID));
    return new Map(constants.map(constant => [constant.name, constant.defaultValue.trim()]));
}

function findServerSuffixes(values: Map<string, string>): string[] {
    const prefix = `${CONSTANT_API_BASE_URL}_`;
    return [...values.keys()]
        .filter(name => name === CONSTANT_API_BASE_URL || name.startsWith(prefix))
        .map(name => name === CONSTANT_API_BASE_URL ? "" : name.slice(prefix.length));
}

function describeServer(suffix: string, values: Map<string, string>): string {
    const name = withSuffix(CONSTANT_API_BASE_URL, suffix);
    return `'${suffix || "(single server)"}' from ${IMPLEMENTATION_MODULE}.${name} = ${values.get(name) || "(empty)"}`;
}

function pickServerSuffix(input: ConnectInput, values: Map<string, string>): string {
    const available = findServerSuffixes(values);
    if (input.server) {
        const suffix = toServerSuffix(input.server);
        if (!available.includes(suffix)) {
            throw new Error(
                `There is no constant ${IMPLEMENTATION_MODULE}.${withSuffix(CONSTANT_API_BASE_URL, suffix)}. ` +
                (available.length > 0 ? `Servers found: ${available.map(s => describeServer(s, values)).join("; ")}. ` : "") +
                `Create the constants first, then call again. ${CONSTANT_NAMING_HELP}`
            );
        }
        return suffix;
    }
    if (available.length === 1) return available[0];
    if (available.length === 0) {
        throw new Error(
            `No i3X server constants found in ${IMPLEMENTATION_MODULE}. Ask the user for the server URL and auth ` +
            `settings, create the constants with these names, then call again. ${CONSTANT_NAMING_HELP}`
        );
    }
    throw new Error(
        `Several i3X servers are configured: ${available.map(s => describeServer(s, values)).join("; ")}. ` +
        "Ask the user which one, then call again with that server."
    );
}

function readAuth(input: ConnectInput, values: Map<string, string>, suffix: string): AuthConfig {
    const tokenName = withSuffix(CONSTANT_API_TOKEN, suffix);
    const usernameName = withSuffix(CONSTANT_API_USERNAME, suffix);
    const passwordName = withSuffix(CONSTANT_API_PASSWORD, suffix);
    const hasToken = values.has(tokenName);
    const hasBasic = values.has(usernameName) || values.has(passwordName);

    let mode = input.auth;
    if (!mode) {
        if (hasToken && hasBasic) {
            throw new Error(`Both ${tokenName} and ${usernameName}/${passwordName} exist. Ask the user which auth the server uses, then call again with auth 'token' or 'basic'.`);
        }
        mode = hasToken ? "token" : hasBasic ? "basic" : "none";
    }

    const requireValue = (name: string): string => {
        const value = values.get(name);
        if (value === undefined) throw new Error(`The constant ${IMPLEMENTATION_MODULE}.${name} does not exist. Create it, then call again. ${CONSTANT_NAMING_HELP}`);
        if (!value) throw new Error(`The constant ${IMPLEMENTATION_MODULE}.${name} has no default value. Fill it, then call again.`);
        return value;
    };

    if (mode === "none") return { mode: "none" };
    if (mode === "basic") {
        return { mode: "basic", username: requireValue(usernameName), password: requireValue(passwordName) };
    }
    const headerName = input.tokenHeaderName || "Authorization";
    const prefix = input.tokenPrefix ?? (headerName.toLowerCase() === "authorization" ? "Bearer" : "");
    return { mode: "token", token: requireValue(tokenName), headerName, prefix };
}

export async function readConnectionFromConstants(sp: StudioProApi, input: ConnectInput): Promise<ConnectionConfig> {
    const values = await loadModuleConstants(sp);
    const suffix = pickServerSuffix(input, values);
    const baseUrlName = withSuffix(CONSTANT_API_BASE_URL, suffix);
    const apiBaseUrl = values.get(baseUrlName) ?? "";
    const normalizedBaseUrl = getApiBaseUrl(apiBaseUrl);
    if (!normalizedBaseUrl) {
        throw new Error(`The constant ${IMPLEMENTATION_MODULE}.${baseUrlName} does not hold a server URL. Fill it with the i3X server URL, then call again.`);
    }

    // The generators name multi-server constants after the URL. A hand-made name that does not
    // match would make them create a second set of constants for the same server.
    if (suffix && deriveEndpointFolderName(normalizedBaseUrl) !== suffix) {
        const expected = deriveEndpointFolderName(normalizedBaseUrl);
        throw new Error(
            `The constant name ${baseUrlName} does not match its URL ${normalizedBaseUrl}. ` +
            `For that URL, the constants must end in _${expected}, for example ${CONSTANT_API_BASE_URL}_${expected}. ` +
            "Rename the constants, then call again."
        );
    }

    return { apiBaseUrl, auth: readAuth(input, values, suffix), multiServerMode: suffix !== "" };
}

export function parseConnectInput(input: Record<string, unknown>): ConnectInput {
    const text = (key: string): string | null =>
        typeof input[key] === "string" && (input[key] as string).trim() ? (input[key] as string).trim() : null;
    const auth = text("auth");
    if (auth !== null && !AUTH_MODES.includes(auth as AuthMode)) {
        throw new Error(`'auth' must be one of: ${AUTH_MODES.join(", ")}.`);
    }
    // An empty prefix is a real choice (a custom header without a prefix), so keep "" apart from absent.
    const tokenPrefix = typeof input.tokenPrefix === "string" ? input.tokenPrefix.trim() : null;
    return { server: text("server"), auth: auth as AuthMode | null, tokenHeaderName: text("tokenHeaderName"), tokenPrefix };
}

export { AUTH_MODES };
