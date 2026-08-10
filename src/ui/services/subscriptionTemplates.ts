import { IMPLEMENTATION_MODULE } from '../constants';

export interface SubscriptionArtifactNames {
    subscription: string;
    batch: string;
    update: string;
}

export interface SubscriptionRestDefinition {
    name: string;
    endpoint: string;
    parameters: Array<{ name: string; entityQualifiedName?: string }>;
    requestBody: string;
    requestBodyArgs: string[];
    importMappingName?: string;
    output?: { variableName: string; entityName: string; isList: boolean };
    commitImportedResult?: boolean;
    annotationText?: string;
}

export function buildSubscriptionSyncRequestExpression(subscriptionClientIdConstantRef: string): string {
    // Mendix expressions use unqualified object member paths. Constants remain qualified.
    return `if $Subscription/lastSequenceNumber != empty\n` +
        `then '{"clientId":"' + ${subscriptionClientIdConstantRef} + '","subscriptionId":"' + $Subscription/subscriptionId + '","lastSequenceNumber":' + $Subscription/lastSequenceNumber + '}'\n` +
        `else '{"clientId":"' + ${subscriptionClientIdConstantRef} + '","subscriptionId":"' + $Subscription/subscriptionId + '}'`;
}

export function buildSubscriptionRestDefinitions(
    baseEntityName: string,
    entityNames: SubscriptionArtifactNames,
    subscriptionClientIdConstantRef: string,
    createMappingName: string
): SubscriptionRestDefinition[] {
    const subscriptionEntity = `${IMPLEMENTATION_MODULE}.${entityNames.subscription}`;
    return [
        {
            name: `MF_${baseEntityName}_SubscribeCreate`,
            endpoint: '/subscriptions',
            parameters: [{ name: 'DisplayName' }],
            requestBody: '{{"clientId":"{1}","displayName":"{2}"}',
            requestBodyArgs: [subscriptionClientIdConstantRef, '$DisplayName'],
            importMappingName: createMappingName,
            output: { variableName: 'Subscription', entityName: entityNames.subscription, isList: false },
            commitImportedResult: true,
        },
        {
            name: `MF_${baseEntityName}_SubscribeRegister`,
            endpoint: '/subscriptions/register',
            parameters: [{ name: 'Subscription', entityQualifiedName: subscriptionEntity }],
            requestBody: '{{"clientId":"{1}","subscriptionId":"{2}","elementIds":["{3}"],"maxDepth":1}',
            requestBodyArgs: [
                subscriptionClientIdConstantRef,
                '$Subscription/subscriptionId',
                '$Subscription/elementId',
            ],
            annotationText: 'Set Subscription.elementId before calling this microflow. Register reads the existing value and does not choose an element ID.',
        },
        {
            name: `MF_${baseEntityName}_Unsubscribe`,
            endpoint: '/subscriptions/delete',
            parameters: [{ name: 'Subscription', entityQualifiedName: subscriptionEntity }],
            requestBody: '{{"clientId":"{1}","subscriptionIds":["{2}"]}',
            requestBodyArgs: [subscriptionClientIdConstantRef, '$Subscription/subscriptionId'],
        },
    ];
}
