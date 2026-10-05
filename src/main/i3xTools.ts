import type { StudioProApi } from "@mendix/extensions-api";
import type { ConnectionConfig } from "../ui/types/connection";
import { isObjectTypeArray, type ObjectType } from "../ui/types/objecttype";
import { buildI3xRequestHeaders } from "../ui/services/auth";
import { getObjectTypesUrl, getObjectsUrl, unwrapI3xResult } from "../ui/services/i3xUrl";
import {
    checkValueQueryEntitiesExist,
    createHistoryMicroflow,
    createQueryValuesMicroflow,
    createSubscriptionArtifacts,
    createWriteMicroflow,
    summarizeArtifactResult,
} from "../ui/services/studioProService";
import { getLastConnection } from "./connectionStore";
import type { ExternalAIToolDefinition } from "./aiTools";

const NOT_CONNECTED =
    "Not connected to an i3X server. Ask the user to open Extensions > i3X Connector, " +
    "enter the server URL and credentials, and press Load. Then try again.";

const MAX_LISTED_OBJECTS = 50;

const OBJECT_TYPE_INPUT_DESCRIPTION =
    "The i3X object type: its displayName (for example 'Pump', as the user said it) or its elementId. " +
    "Partial names work when they match exactly one type.";

// The app also contains Mendix modules with i3x in their names, and Maia confused them with
// these tools. Every description spells out that the tools talk to the remote server.
const SCOPE_NOTE =
    "This tool does not read or search the Mendix modules, entities or microflows already in the app " +
    "(such as i3x_connector or i3x_implementation); it only talks to the i3X server the user connected " +
    "to in the i3X Connector tab.";

// Order matters: write and subscription need the entities that the value query creates.
const ARTIFACT_KINDS = ["valueQuery", "history", "write", "subscription"] as const;
type ArtifactKind = typeof ARTIFACT_KINDS[number];

function requireConnection(): ConnectionConfig {
    const connection = getLastConnection();
    if (!connection) throw new Error(NOT_CONNECTED);
    return connection;
}

async function fetchI3xJson(sp: StudioProApi, url: string, connection: ConnectionConfig): Promise<unknown> {
    const proxyUrl = await sp.network.httpProxy.getProxyUrl(url);
    const response = await fetch(proxyUrl, { headers: buildI3xRequestHeaders(connection.auth) });
    if (!response.ok) {
        throw new Error(`Request failed with status ${response.status} for '${url}'.`);
    }
    return unwrapI3xResult(await response.json());
}

async function fetchObjectTypes(sp: StudioProApi, connection: ConnectionConfig): Promise<ObjectType[]> {
    const url = getObjectTypesUrl(connection.apiBaseUrl);
    if (!url) throw new Error(`Cannot build the object types URL from '${connection.apiBaseUrl}'.`);
    const data = await fetchI3xJson(sp, url, connection);
    if (!isObjectTypeArray(data)) throw new Error(`'${url}' did not return a list of object types.`);
    return data;
}

async function fetchObjects(sp: StudioProApi, connection: ConnectionConfig, typeId: string): Promise<Record<string, unknown>[]> {
    const url = getObjectsUrl(connection.apiBaseUrl, typeId);
    if (!url) throw new Error(`Cannot build the objects URL from '${connection.apiBaseUrl}'.`);
    const data = await fetchI3xJson(sp, url, connection);
    return Array.isArray(data)
        ? data.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        : [];
}

// Accepts an elementId or a display name, so Maia can pass what the user said
// ("the pumps") without copying an id from an earlier answer.
async function findObjectType(sp: StudioProApi, connection: ConnectionConfig, reference: string): Promise<ObjectType> {
    const types = await fetchObjectTypes(sp, connection);
    const lower = reference.toLowerCase();
    const match = types.find(t => t.elementId === reference)
        ?? types.find(t => t.elementId.toLowerCase() === lower)
        ?? types.find(t => t.displayName.toLowerCase() === lower);
    if (match) return match;

    const partial = types.filter(t => t.displayName.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    const candidates = (partial.length > 1 ? partial : types).map(t => `'${t.displayName}' (${t.elementId})`).join(", ");
    throw new Error(
        partial.length > 1
            ? `'${reference}' matches several object types: ${candidates}. Ask the user which one and call again with its elementId.`
            : `No object type matches '${reference}'. Available types: ${candidates}.`
    );
}

// Results carry a timestamp and an explicit note, because Maia otherwise answers
// follow-up questions from an earlier tool result instead of calling the tool again.
function liveResult(summary: string, data: unknown, next: string): string {
    return [
        `${summary} Fetched live from the i3X server at ${new Date().toISOString()}.`,
        "This is live data that can change; call the tool again for each new question instead of reusing this result.",
        `Data: ${JSON.stringify(data)}`,
        `Next: ${next}`,
    ].join("\n");
}

function readElementId(item: Record<string, unknown>): string | null {
    const entry = Object.entries(item).find(([key]) => key.toLowerCase() === "elementid");
    return typeof entry?.[1] === "string" && entry[1].trim() ? entry[1].trim() : null;
}

function requireString(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`'${key}' must be a non-empty string.`);
    return value.trim();
}

function parseArtifactKinds(value: unknown): ArtifactKind[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`'artifacts' must be a non-empty list of: ${ARTIFACT_KINDS.join(", ")}.`);
    }
    const unknownKinds = value.filter(v => !ARTIFACT_KINDS.includes(v as ArtifactKind));
    if (unknownKinds.length > 0) {
        throw new Error(`Unknown artifact kinds: ${unknownKinds.join(", ")}. Allowed: ${ARTIFACT_KINDS.join(", ")}.`);
    }
    return ARTIFACT_KINDS.filter(kind => value.includes(kind));
}

// Maia reads the returned string, so failures come back as text instead of a thrown error.
function asToolResult(run: (input: Record<string, unknown>) => Promise<string>) {
    return async (input: Record<string, unknown>) => {
        try {
            return await run(input ?? {});
        } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    };
}

async function generateArtifacts(sp: StudioProApi, input: Record<string, unknown>): Promise<string> {
    const connection = requireConnection();
    const typeReference = requireString(input, "objectType");
    const kinds = parseArtifactKinds(input.artifacts);
    const requestedElementId = typeof input.elementId === "string" && input.elementId.trim() ? input.elementId.trim() : null;

    const objectType = await findObjectType(sp, connection, typeReference);
    const lines: string[] = [`Object type '${objectType.displayName}' (${objectType.elementId}):`];

    if (kinds.includes("valueQuery")) {
        // Same default as the tab: the first object of the type is the sample, if there is one.
        let sampleElementId = requestedElementId;
        if (!sampleElementId) {
            const objects = await fetchObjects(sp, connection, objectType.elementId);
            sampleElementId = objects.map(readElementId).find((id): id is string => id !== null) ?? null;
        }
        const result = await createQueryValuesMicroflow(objectType, sampleElementId ? { elementId: sampleElementId } : null, connection);
        lines.push(`- Value query: ${summarizeArtifactResult(result).summary}`);
        if (result.jsonFetchFailed || !sampleElementId) {
            lines.push("  Note: no live object was available, so the JSON structure was built from the type schema. Property types may not match what the server returns.");
        }
    }

    if (kinds.includes("history")) {
        const result = await createHistoryMicroflow(objectType, connection);
        lines.push(`- History: microflow '${result.microflowName}' ${result.microflowCreated ? "created" : "already exists"}; JSON structure '${result.jsonStructureName}', import mapping '${result.importMappingName}'.`);
    }

    const needsValueQueryEntities = kinds.includes("write") || kinds.includes("subscription");
    if (needsValueQueryEntities && !(await checkValueQueryEntitiesExist(objectType))) {
        lines.push("- Write and subscription skipped: they need the value query entities. Include 'valueQuery' in the same request, or generate it first.");
        return lines.join("\n");
    }

    if (kinds.includes("write")) {
        const result = await createWriteMicroflow(objectType, connection);
        lines.push(`- Write: microflow '${result.microflowName}' ${result.microflowCreated ? "created" : "already exists"}; export mapping '${result.exportMappingName}'.`);
        if (result.microflowCreated) {
            lines.push(`  Action needed: open '${result.microflowName}' and change the REST call HTTP method to PUT before using it.`);
        }
    }

    if (kinds.includes("subscription")) {
        const result = await createSubscriptionArtifacts(objectType, connection);
        lines.push(`- Subscription: ${result.microflowsCreated} of ${result.microflowNames.length} microflows created (${result.microflowNames.join(", ")}); state entity '${result.subscriptionEntityName}'.`);
    }

    lines.push("Next: tell the user which artifacts were created. To generate more kinds for this type, call i3x_generate_artifacts again.");
    return lines.join("\n");
}

export function buildI3xTools(sp: StudioProApi): ExternalAIToolDefinition[] {
    return [
        {
            name: "i3x_list_object_types",
            description:
                "Calls the remote CESMII i3X server over HTTP and lists its object types (equipment and data " +
                "models, for example a motor drive or a pump). Returns each type's elementId, display name and " +
                "top-level properties. The server's types can change, so call this tool every time the user asks " +
                "about them instead of reusing an earlier answer. " + SCOPE_NOTE,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            inProgressMessage: "Reading i3X object types...",
            run: asToolResult(async () => {
                const types = await fetchObjectTypes(sp, requireConnection());
                const summary = types.map(t => ({
                    elementId: t.elementId,
                    displayName: t.displayName,
                    properties: Object.keys(t.schema?.properties ?? {}),
                }));
                return liveResult(
                    `${types.length} object types.`,
                    summary,
                    "to list the objects of a type, call i3x_list_objects; to generate Mendix artifacts, call i3x_generate_artifacts. Both accept the type's displayName or elementId."
                );
            }),
        },
        {
            name: "i3x_list_objects",
            description:
                "Calls the remote CESMII i3X server over HTTP and lists the object instances of one object type, " +
                "for example the individual pumps of type Pump. Returns each object's elementId and display name, " +
                `at most ${MAX_LISTED_OBJECTS}. Objects change on the server, so call this tool every time the user ` +
                "asks about them instead of reusing an earlier answer. You do not need to call i3x_list_object_types " +
                "first: pass the type's display name as the user said it. " + SCOPE_NOTE,
            inputSchema: {
                type: "object",
                properties: {
                    objectType: { type: "string", description: OBJECT_TYPE_INPUT_DESCRIPTION },
                },
                required: ["objectType"],
                additionalProperties: false,
            },
            inProgressMessage: "Reading i3X objects...",
            run: asToolResult(async input => {
                const connection = requireConnection();
                const objectType = await findObjectType(sp, connection, requireString(input, "objectType"));
                const objects = await fetchObjects(sp, connection, objectType.elementId);
                const listed = objects.slice(0, MAX_LISTED_OBJECTS).map(o => ({
                    elementId: readElementId(o),
                    displayName: typeof o.displayName === "string" ? o.displayName : null,
                }));
                const more = objects.length > MAX_LISTED_OBJECTS ? ` (${objects.length - MAX_LISTED_OBJECTS} more not listed)` : "";
                return liveResult(
                    `${objects.length} objects of type '${objectType.displayName}' (${objectType.elementId})${more}.`,
                    listed,
                    `to generate Mendix artifacts for this type, call i3x_generate_artifacts with objectType '${objectType.elementId}'; pass one of these elementIds as elementId to use it as the live sample.`
                );
            }),
        },
        {
            name: "i3x_generate_artifacts",
            description:
                "Reads one object type from the remote CESMII i3X server and generates new Mendix artifacts for it " +
                "in the i3X_Implementation module: entities, JSON structures, " +
                "import/export mappings and microflows that call the i3X server. Artifact kinds: " +
                "'valueQuery' (read current values), 'history' (read historical values), " +
                "'write' (write values back; needs valueQuery), 'subscription' (subscribe to changes; needs valueQuery). " +
                "Existing artifacts are reused, not duplicated. " + SCOPE_NOTE,
            inputSchema: {
                type: "object",
                properties: {
                    objectType: { type: "string", description: OBJECT_TYPE_INPUT_DESCRIPTION },
                    artifacts: {
                        type: "array",
                        items: { type: "string", enum: [...ARTIFACT_KINDS] },
                        minItems: 1,
                        description: "Which artifacts to generate.",
                    },
                    elementId: {
                        type: "string",
                        description: "Optional object elementId (from i3x_list_objects) used as the live sample for 'valueQuery'. Defaults to the type's first object.",
                    },
                },
                required: ["objectType", "artifacts"],
                additionalProperties: false,
            },
            inProgressMessage: "Generating i3X artifacts...",
            run: asToolResult(input => generateArtifacts(sp, input)),
        },
    ];
}
