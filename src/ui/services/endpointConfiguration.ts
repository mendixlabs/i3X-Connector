import type { Projects } from '@mendix/extensions-api';
import {
    CONSTANT_API_BASE_URL,
    CONSTANT_API_PASSWORD,
    CONSTANT_API_TOKEN,
    CONSTANT_API_USERNAME,
    CONSTANT_SUBSCRIPTION_CLIENT_ID,
    IMPLEMENTATION_MODULE,
} from '../constants';
import type { AuthConfig, ConnectionConfig } from '../types';
import { sanitizeHeaderName, type AuthConstantRefs } from './auth';
import { getApiBaseUrl } from './i3xUrl';
import { getStudioPro } from './studioProContext';

export interface EndpointSetup {
    baseUrlConstantRef: string;
    subscriptionClientIdConstantRef: string;
    authRefs: AuthConstantRefs;
    endpointFolderId: string;
}

export interface ObjectTypeFolders {
    objectTypeFolderId: string;
    mappingsFolderId: string;
}

export interface ObjectTypeArtifactContext extends EndpointSetup, ObjectTypeFolders {
    objectTypeName: string;
}

function sanitizeFolderName(raw: string): string {
    return raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'Endpoint';
}

function deriveEndpointFolderName(normalizedBaseUrl: string): string {
    try {
        const url = new URL(normalizedBaseUrl);
        const host = url.hostname;
        const port = url.port ? `_${url.port}` : '';
        const path = url.pathname.replace(/^\/|\/$/g, '').replace(/\//g, '_');
        const raw = path ? `${host}${port}_${path}` : `${host}${port}`;
        return sanitizeFolderName(raw);
    } catch {
        return sanitizeFolderName(normalizedBaseUrl);
    }
}

async function ensureFolder(parentId: string, name: string): Promise<{ $ID: string }> {
    const sp = getStudioPro();
    return (await sp.app.model.projects.getFolder(parentId, name))
        ?? await sp.app.model.projects.addFolder(parentId, name);
}

export async function ensureObjectTypeFolders(parentId: string, objectTypeName: string): Promise<ObjectTypeFolders> {
    const objectTypeFolder = await ensureFolder(parentId, sanitizeFolderName(objectTypeName));
    const mappingsFolder = await ensureFolder(objectTypeFolder.$ID, 'Mappings');
    return { objectTypeFolderId: objectTypeFolder.$ID, mappingsFolderId: mappingsFolder.$ID };
}

export async function ensureObjectTypeArtifactContext(
    connection: ConnectionConfig,
    objectTypeName: string
): Promise<ObjectTypeArtifactContext> {
    const endpoint = await ensureEndpointConstants(connection);
    const folders = await ensureObjectTypeFolders(endpoint.endpointFolderId, objectTypeName);
    return { ...endpoint, ...folders, objectTypeName };
}

function withSuffix(name: string, suffix: string): string {
    return suffix ? `${name}_${suffix}` : name;
}

async function getRequiredProjectModule(): Promise<Readonly<Projects.Module>> {
    const sp = getStudioPro();
    return (await sp.app.model.modules.getModule(IMPLEMENTATION_MODULE))
        ?? sp.app.model.modules.addModule(IMPLEMENTATION_MODULE);
}

async function getExistingConstantNames(): Promise<Set<string>> {
    const sp = getStudioPro();
    return new Set(
        (await sp.app.model.constants.getUnitsInfo())
            .filter(unit => unit.moduleName === IMPLEMENTATION_MODULE)
            .map(unit => unit.name)
            .filter((name): name is string => name !== undefined)
    );
}

async function ensureAuthConstants(
    auth: AuthConfig,
    suffix: string,
    containerFolderId: string,
    existingNames: Set<string>
): Promise<AuthConstantRefs> {
    if (auth.mode === 'none') return { mode: 'none' };

    const sp = getStudioPro();

    if (auth.mode === 'basic') {
        const usernameName = withSuffix(CONSTANT_API_USERNAME, suffix);
        const passwordName = withSuffix(CONSTANT_API_PASSWORD, suffix);
        const toCreate: { name: string; value: string }[] = [];
        if (!existingNames.has(usernameName)) toCreate.push({ name: usernameName, value: auth.username });
        if (!existingNames.has(passwordName)) toCreate.push({ name: passwordName, value: auth.password });

        if (toCreate.length > 0) {
            const configFolder = await ensureFolder(containerFolderId, 'Configuration');
            const constantNames = toCreate.map(constant => `• ${IMPLEMENTATION_MODULE}.${constant.name}`).join('\n');
            const prefill = await sp.ui.messageBoxes.ask({
                type: 'confirmation',
                question: `The following Constants will be created to store authentication credentials:\n\n${constantNames}\n\nPrefill with the credentials you entered?`,
            });
            for (const { name, value } of toCreate) {
                await sp.app.model.constants.addConstant(configFolder.$ID, {
                    name, type: 'String', defaultValue: prefill ? value : '', exposedToClient: false,
                });
            }
        }
        return {
            mode: 'basic',
            usernameRef: `@${IMPLEMENTATION_MODULE}.${usernameName}`,
            passwordRef: `@${IMPLEMENTATION_MODULE}.${passwordName}`,
        };
    }

    const tokenName = withSuffix(CONSTANT_API_TOKEN, suffix);
    if (!existingNames.has(tokenName)) {
        const configFolder = await ensureFolder(containerFolderId, 'Configuration');
        const prefill = await sp.ui.messageBoxes.ask({
            type: 'confirmation',
            question: `The Constant '${IMPLEMENTATION_MODULE}.${tokenName}' will be created to store the authentication token.\n\nPrefill with the token you entered?`,
        });
        await sp.app.model.constants.addConstant(configFolder.$ID, {
            name: tokenName, type: 'String', defaultValue: prefill ? auth.token : '', exposedToClient: false,
        });
    }

    return {
        mode: 'token',
        tokenRef: `@${IMPLEMENTATION_MODULE}.${tokenName}`,
        headerName: sanitizeHeaderName(auth.headerName) || 'Authorization',
        prefix: auth.prefix.trim(),
    };
}

async function ensureSingleServerConfiguration(
    connection: ConnectionConfig,
    normalizedBaseUrl: string,
    moduleId: string
): Promise<EndpointSetup> {
    const sp = getStudioPro();
    const existingNames = await getExistingConstantNames();

    if (!existingNames.has(CONSTANT_API_BASE_URL)) {
        const configFolder = await ensureFolder(moduleId, 'Configuration');
        await sp.app.model.constants.addConstant(configFolder.$ID, {
            name: CONSTANT_API_BASE_URL,
            type: 'String',
            defaultValue: normalizedBaseUrl,
            exposedToClient: false,
        });
    }

    if (!existingNames.has(CONSTANT_SUBSCRIPTION_CLIENT_ID)) {
        const configFolder = await ensureFolder(moduleId, 'Configuration');
        await sp.app.model.constants.addConstant(configFolder.$ID, {
            name: CONSTANT_SUBSCRIPTION_CLIENT_ID,
            type: 'String',
            defaultValue: 'Mendix-i3X-Connector',
            exposedToClient: false,
        });
    }

    return {
        baseUrlConstantRef: `@${IMPLEMENTATION_MODULE}.${CONSTANT_API_BASE_URL}`,
        subscriptionClientIdConstantRef: `@${IMPLEMENTATION_MODULE}.${CONSTANT_SUBSCRIPTION_CLIENT_ID}`,
        authRefs: await ensureAuthConstants(connection.auth, '', moduleId, existingNames),
        endpointFolderId: moduleId,
    };
}

export async function ensureEndpointConstants(connection: ConnectionConfig): Promise<EndpointSetup> {
    const normalizedBaseUrl = getApiBaseUrl(connection.apiBaseUrl);
    if (!normalizedBaseUrl) {
        throw new Error(`Cannot build base API URL from '${connection.apiBaseUrl}'.`);
    }

    const module = await getRequiredProjectModule();
    if (!connection.multiServerMode) {
        return ensureSingleServerConfiguration(connection, normalizedBaseUrl, module.$ID);
    }

    const sp = getStudioPro();
    const folderName = deriveEndpointFolderName(normalizedBaseUrl);
    const endpointFolder = await ensureFolder(module.$ID, folderName);
    const baseUrlConstantName = `API_BaseUrl_${folderName}`;
    const existingNames = await getExistingConstantNames();

    if (!existingNames.has(CONSTANT_SUBSCRIPTION_CLIENT_ID)) {
        const configFolder = await ensureFolder(module.$ID, 'Configuration');
        await sp.app.model.constants.addConstant(configFolder.$ID, {
            name: CONSTANT_SUBSCRIPTION_CLIENT_ID,
            type: 'String',
            defaultValue: 'Mendix-i3X-Connector',
            exposedToClient: false,
        });
    }

    if (!existingNames.has(baseUrlConstantName)) {
        const configFolder = await ensureFolder(endpointFolder.$ID, 'Configuration');
        await sp.app.model.constants.addConstant(configFolder.$ID, {
            name: baseUrlConstantName,
            type: 'String',
            defaultValue: normalizedBaseUrl,
            exposedToClient: false,
        });
    }

    return {
        baseUrlConstantRef: `@${IMPLEMENTATION_MODULE}.${baseUrlConstantName}`,
        subscriptionClientIdConstantRef: `@${IMPLEMENTATION_MODULE}.${CONSTANT_SUBSCRIPTION_CLIENT_ID}`,
        authRefs: await ensureAuthConstants(connection.auth, folderName, endpointFolder.$ID, existingNames),
        endpointFolderId: endpointFolder.$ID,
    };
}
