import type { DataTypes, Microflows, Primitives, StudioProApi } from '@mendix/extensions-api';
import { configureHttpAuthForMicroflow, type AuthConstantRefs } from './auth';

export interface RestMicroflowOptions {
    url: string;
    urlArgs?: string[];
    requestBody: string;
    requestBodyArgs?: string[];
    requestBodyVariable?: { name: string; expression: string };
    extraHeaders?: Array<{ key: string; value: string }>;
    authRefs: AuthConstantRefs;
    importMappingQualifiedName?: string;
    importMappingOutput?: {
        outputVariableName: string;
        entityQualifiedName: string;
        isList: boolean;
        inputVariableName?: string;
    };
    exportMapping?: {
        mappingQualifiedName: string;
        entityVariableName: string;
    };
    annotationText?: string;
    returnMappedResult?: boolean;
    commitImportedResult?: boolean;
    persistMaxSequence?: {
        inputListVariableName: string;
        sequenceAttribute: string;
        outputVariableName: string;
        targetObjectVariableName: string;
        targetAttribute: string;
    };
}

export function buildValueQueryHttpRequestBody(selectedElementId: string): string {
    return `{
  "elementIds": [
    "${selectedElementId}"
  ],
  "maxDepth": 1
}`;
}

export interface RequestTemplate {
    text: string;
    args: string[];
}

export function buildHistoryMicroflowRequestBody(): RequestTemplate {
    return {
        // {1} = $ElementId, {2} = ISO 8601 UTC start, {3} = ISO 8601 UTC end
        text: `{{"elementIds":["{1}"],"startTime":"{2}","endTime":"{3}"}`,
        args: ['$ElementId', "formatDateTimeUTC($StartTime, 'yyyy-MM-dd''T''HH:mm:ss.SSS''Z''')", "formatDateTimeUTC($EndTime, 'yyyy-MM-dd''T''HH:mm:ss.SSS''Z''')"],
    };
}

export function buildValueQueryMicroflowRequestBody(): RequestTemplate {
    return {
        text: `{{
  "elementIds": [
        "{1}"
  ],
  "maxDepth": 1
}`,
        args: ['$ElementId'],
    };
}

// Thin wrapper around createElement that keeps the generic + literal type argument together
// at the call site (required so the SDK can resolve $CreationOptions for that element type),
// without repeating the `(await ...) as X` cast at every call site.
function createMicroflowElement<T extends Primitives.ElementBase>(
    sp: StudioProApi,
    type: T['$Type'],
    options?: T['$CreationOptions']
): Promise<T> {
    return sp.app.model.microflows.createElement<T>(type, options);
}

async function addHttpHeadersToConfiguration(
    sp: StudioProApi,
    httpConfiguration: Microflows.HttpConfiguration,
    headers: Array<{ key: string; value: string }>
): Promise<void> {
    for (const { key, value } of headers) {
        const headerEntry = await createMicroflowElement<Microflows.HttpHeaderEntry>(sp, 'Microflows$HttpHeaderEntry');
        headerEntry.key = key;
        headerEntry.value = value;
        httpConfiguration.headerEntries.push(headerEntry);
    }
}

async function createSequenceFlow(
    sp: StudioProApi,
    startId: string,
    endId: string,
    exclusiveSplitValue?: boolean,
    isErrorHandler?: boolean,
    originConnectionIndex?: number,
    destinationConnectionIndex?: number
): Promise<Microflows.SequenceFlow> {
    const sequenceFlow = await createMicroflowElement<Microflows.SequenceFlow>(sp, 'Microflows$SequenceFlow');
    sequenceFlow.origin = startId;
    sequenceFlow.destination = endId;
    sequenceFlow.isErrorHandler = isErrorHandler ?? false;
    if (originConnectionIndex !== undefined) sequenceFlow.originConnectionIndex = originConnectionIndex;
    if (destinationConnectionIndex !== undefined) sequenceFlow.destinationConnectionIndex = destinationConnectionIndex;
    if (exclusiveSplitValue !== undefined) {
        const caseValue = await createMicroflowElement<Microflows.EnumerationCase>(sp, 'Microflows$EnumerationCase');
        caseValue.value = exclusiveSplitValue ? 'true' : 'false';
        sequenceFlow.caseValues = [caseValue];
    }
    return sequenceFlow;
}

async function createAnnotationFlow(
    sp: StudioProApi,
    annotationId: string,
    targetId: string,
    originConnectionIndex?: number,
    destinationConnectionIndex?: number
): Promise<Microflows.AnnotationFlow> {
    const annotationFlow = await createMicroflowElement<Microflows.AnnotationFlow>(sp, 'Microflows$AnnotationFlow');
    annotationFlow.origin = annotationId;
    annotationFlow.destination = targetId;
    if (originConnectionIndex !== undefined) annotationFlow.originConnectionIndex = originConnectionIndex;
    if (destinationConnectionIndex !== undefined) annotationFlow.destinationConnectionIndex = destinationConnectionIndex;
    return annotationFlow;
}

async function createMessageActivity(
    sp: StudioProApi,
    type: Microflows.ShowMessageType,
    messageText: string,
    expressionArgs: string[]
): Promise<Microflows.ActionActivity> {
    const messageActivity = await createMicroflowElement<Microflows.ActionActivity>(sp, 'Microflows$ActionActivity');
    const showMessage = await createMicroflowElement<Microflows.ShowMessageAction>(
        sp,
        'Microflows$ShowMessageAction',
        { type, template: { text: messageText, arguments: expressionArgs } }
    );
    messageActivity.action = showMessage;
    return messageActivity;
}

async function createLogMessageActivity(
    sp: StudioProApi,
    messageText: string,
    expressionArgs: string[]
): Promise<Microflows.ActionActivity> {
    const activity = await createMicroflowElement<Microflows.ActionActivity>(sp, 'Microflows$ActionActivity');
    const logAction = await createMicroflowElement<Microflows.LogMessageAction>(sp, 'Microflows$LogMessageAction');
    const template = await createMicroflowElement<Microflows.StringTemplate>(
        sp,
        'Microflows$StringTemplate',
        { text: messageText, arguments: expressionArgs }
    );

    logAction.messageTemplate = template;
    logAction.level = 'Error';
    logAction.node = "'i3X'";
    logAction.includeLatestStackTrace = false;
    activity.action = logAction;
    return activity;
}

// MappingRequestHandling can only be contained in ExportXmlAction, not RestCallAction. The
// correct pattern: ExportXmlAction serialises the entity to $SerializedJson, then RestCallAction
// reads $SerializedJson via CustomRequestHandling. Returns the pushed ExportXmlAction's $ID,
// needed by the caller to wire it into the start-to-REST-call sequence flow.
async function buildExportRequestBranch(
    sp: StudioProApi,
    microflow: Microflows.Microflow,
    restCall: Microflows.RestCallAction,
    exportMapping: NonNullable<RestMicroflowOptions['exportMapping']>
): Promise<string> {
    const exportActivity = await createMicroflowElement<Microflows.ActionActivity>(sp, 'Microflows$ActionActivity');
    const exportXmlAction = await createMicroflowElement<Microflows.ExportXmlAction>(sp, 'Microflows$ExportXmlAction');
    const exportResultHandling = await createMicroflowElement<Microflows.MappingRequestHandling>(sp, 'Microflows$MappingRequestHandling');
    const variableExport = await createMicroflowElement<Microflows.VariableExport>(sp, 'Microflows$VariableExport');

    exportResultHandling.mapping = exportMapping.mappingQualifiedName;
    exportResultHandling.mappingArgumentVariableName = exportMapping.entityVariableName;
    exportResultHandling.contentType = 'Json';
    exportXmlAction.resultHandling = exportResultHandling;
    variableExport.outputVariableName = 'SerializedJson';
    exportXmlAction.outputMethod = variableExport;
    exportXmlAction.isValidationRequired = false;
    exportActivity.action = exportXmlAction;
    exportActivity.size = { width: 120, height: 60 };
    exportActivity.relativeMiddlePoint = { x: 200, y: 200 };
    microflow.objectCollection.objects.push(exportActivity);

    const requestHandler = await createMicroflowElement<Microflows.CustomRequestHandling>(sp, 'Microflows$CustomRequestHandling');
    const requestTemplate = await createMicroflowElement<Microflows.StringTemplate>(sp, 'Microflows$StringTemplate');
    requestTemplate.text = '{1}';
    const serializedJsonArg = await createMicroflowElement<Microflows.TemplateArgument>(sp, 'Microflows$TemplateArgument');
    serializedJsonArg.expression = '$SerializedJson';
    requestTemplate.arguments.push(serializedJsonArg);
    requestHandler.template = requestTemplate;
    restCall.requestHandling = requestHandler;
    restCall.requestHandlingType = 'Custom';

    return exportActivity.$ID;
}

async function buildCustomRequestBody(
    sp: StudioProApi,
    restCall: Microflows.RestCallAction,
    requestBody: string,
    requestBodyArgs: string[]
): Promise<void> {
    const requestHandler = await createMicroflowElement<Microflows.CustomRequestHandling>(sp, 'Microflows$CustomRequestHandling');
    const requestTemplate = await createMicroflowElement<Microflows.StringTemplate>(sp, 'Microflows$StringTemplate');
    requestTemplate.text = requestBody;
    for (const argExpr of requestBodyArgs) {
        const templateArg = await createMicroflowElement<Microflows.TemplateArgument>(sp, 'Microflows$TemplateArgument');
        templateArg.expression = argExpr;
        requestTemplate.arguments.push(templateArg);
    }
    requestHandler.template = requestTemplate;
    restCall.requestHandling = requestHandler;
    restCall.requestHandlingType = 'Custom';
}

async function buildLocationTemplate(sp: StudioProApi, url: string, urlArgs: string[]): Promise<Microflows.StringTemplate> {
    const locationTemplate = await createMicroflowElement<Microflows.StringTemplate>(sp, 'Microflows$StringTemplate');

    if (urlArgs.length > 0) {
        locationTemplate.text = url;
        const locationTemplateArgs: Microflows.TemplateArgument[] = [];
        for (const argExpr of urlArgs) {
            const templateArg = await createMicroflowElement<Microflows.TemplateArgument>(sp, 'Microflows$TemplateArgument');
            templateArg.expression = argExpr;
            locationTemplateArgs.push(templateArg);
        }
        locationTemplate.arguments = locationTemplateArgs;
    } else {
        const locationTemplateArg = await createMicroflowElement<Microflows.TemplateArgument>(sp, 'Microflows$TemplateArgument');
        locationTemplate.text = '{1}';
        locationTemplateArg.expression = `'${url}'`;
        locationTemplate.arguments = [locationTemplateArg];
    }

    return locationTemplate;
}

// Separate ImportXmlAction activity on the success branch — mirrors how ExportXmlAction is
// used before the REST call on the write side, with contentType 'Json' for JSON mappings.
// Returns the pushed activity's $ID, needed by the caller for sequence-flow wiring.
async function buildImportBranch(
    sp: StudioProApi,
    microflow: Microflows.Microflow,
    importMappingQualifiedName: string,
    importMappingOutput: NonNullable<RestMicroflowOptions['importMappingOutput']>,
    commitImportedResult: boolean
): Promise<string> {
    const importActivity = await createMicroflowElement<Microflows.ActionActivity>(sp, 'Microflows$ActionActivity');
    const importXmlAction = await createMicroflowElement<Microflows.ImportXmlAction>(sp, 'Microflows$ImportXmlAction');
    const importResultHandling = await createMicroflowElement<Microflows.ResultHandling>(sp, 'Microflows$ResultHandling');
    const importMappingCall = await createMicroflowElement<Microflows.ImportMappingCall>(sp, 'Microflows$ImportMappingCall');
    const importRange = await createMicroflowElement<Microflows.ConstantRange>(sp, 'Microflows$ConstantRange');
    const importVariableType = (await sp.app.model.microflows.createElement(
        importMappingOutput.isList ? 'DataTypes$ListType' : 'DataTypes$ObjectType'
    )) as Microflows.ResultHandling['variableType'];

    importRange.singleObject = !importMappingOutput.isList;
    importMappingCall.commit = commitImportedResult ? 'Yes' : 'No';
    importMappingCall.contentType = 'Json';
    importMappingCall.forceSingleOccurrence = false; // Don't change this, it will make the import mapping fail silently.
    importMappingCall.mapping = importMappingQualifiedName;
    importMappingCall.range = importRange;

    (importVariableType as { entity?: string }).entity = importMappingOutput.entityQualifiedName;
    importResultHandling.importMappingCall = importMappingCall;
    importResultHandling.storeInVariable = true;
    importResultHandling.outputVariableName = importMappingOutput.outputVariableName;
    importResultHandling.variableType = importVariableType;

    importXmlAction.xmlDocumentVariableName = importMappingOutput.inputVariableName ?? 'ResponseBody';
    importXmlAction.resultHandling = importResultHandling;
    importXmlAction.isValidationRequired = false;

    importActivity.action = importXmlAction;
    importActivity.size = { width: 120, height: 60 };
    importActivity.relativeMiddlePoint = { x: 760, y: 200 };
    microflow.objectCollection.objects.push(importActivity);
    return importActivity.$ID;
}

/**
 * Populate a fresh microflow with the shared REST-call pattern used by both
 * object implementation and value-query generation flows.
 */
export async function populateMicroflowWithRestCall(
    sp: StudioProApi,
    microflow: Microflows.Microflow,
    options: RestMicroflowOptions
): Promise<void> {
    const {
        url,
        urlArgs = [],
        requestBody,
        requestBodyArgs = [],
        requestBodyVariable,
        extraHeaders = [],
        authRefs,
        importMappingQualifiedName,
        importMappingOutput,
        exportMapping,
        annotationText,
        returnMappedResult,
        commitImportedResult = false,
        persistMaxSequence,
    } = options;
    const shouldImportResponse = Boolean(importMappingQualifiedName && importMappingOutput);

    const actionActivity = await createMicroflowElement<Microflows.ActionActivity>(sp, 'Microflows$ActionActivity');
    const restCall = await createMicroflowElement<Microflows.RestCallAction>(sp, 'Microflows$RestCallAction');
    const httpConfiguration = await createMicroflowElement<Microflows.HttpConfiguration>(sp, 'Microflows$HttpConfiguration');
    const resultHandling = await createMicroflowElement<Microflows.ResultHandling>(sp, 'Microflows$ResultHandling');
    const stringType = await createMicroflowElement<DataTypes.StringType>(sp, 'DataTypes$StringType');

    let exportActivityId: string | null = null;
    let requestBodyVariableActivityId: string | null = null;
    if (exportMapping) {
        exportActivityId = await buildExportRequestBranch(sp, microflow, restCall, exportMapping);
    } else {
        await buildCustomRequestBody(sp, restCall, requestBody, requestBodyArgs);
    }

    if (requestBodyVariable) {
        const variableActivity = await createMicroflowElement<Microflows.ActionActivity>(sp, 'Microflows$ActionActivity');
        const createVariable = await createMicroflowElement<Microflows.CreateVariableAction>(
            sp,
            'Microflows$CreateVariableAction',
            { variableName: requestBodyVariable.name, variableType: 'String', initialValue: requestBodyVariable.expression }
        );
        variableActivity.action = createVariable;
        variableActivity.size = { width: 120, height: 60 };
        variableActivity.relativeMiddlePoint = { x: 240, y: 200 };
        microflow.objectCollection.objects.push(variableActivity);
        requestBodyVariableActivityId = variableActivity.$ID;
    }

    httpConfiguration.overrideLocation = true;
    httpConfiguration.customLocationTemplate = await buildLocationTemplate(sp, url, urlArgs);
    await configureHttpAuthForMicroflow(sp, httpConfiguration, authRefs);
    await addHttpHeadersToConfiguration(sp, httpConfiguration, extraHeaders);
    restCall.httpConfiguration = httpConfiguration;

    resultHandling.variableType = stringType as typeof resultHandling.variableType;
    resultHandling.storeInVariable = true;
    resultHandling.outputVariableName = 'ResponseBody';
    restCall.resultHandlingType = 'String';

    restCall.resultHandling = resultHandling;
    restCall.errorResultHandlingType = 'None';
    restCall.errorHandlingType = 'CustomWithoutRollBack';
    restCall.timeOutExpression = '300';

    actionActivity.action = restCall;
    actionActivity.size = { width: 120, height: 60 };
    actionActivity.relativeMiddlePoint = { x: 400, y: 200 };
    microflow.objectCollection.objects.push(actionActivity);

    const logActivity = await createLogMessageActivity(
        sp,
        'i3X REST call failed. StatusCode: {1}, ReasonPhrase: {2}, Content: {3}',
        [
            'toString($latestHttpResponse/StatusCode)',
            '$latestHttpResponse/ReasonPhrase',
            '$latestHttpResponse/Content',
        ]
    );
    logActivity.size = { width: 120, height: 60 };
    logActivity.relativeMiddlePoint = { x: 400, y: 80 };
    microflow.objectCollection.objects.push(logActivity);

    const handlerEndEvent = await createMicroflowElement<Microflows.EndEvent>(
        sp,
        'Microflows$EndEvent',
        returnMappedResult ? { returnValue: 'empty' } : {}
    );
    handlerEndEvent.relativeMiddlePoint = { x: 520, y: 80 };
    microflow.objectCollection.objects.push(handlerEndEvent);

    if (annotationText) {
        const annotation = await createMicroflowElement<Microflows.Annotation>(sp, 'Microflows$Annotation', {
            caption: annotationText,
            relativeMiddlePoint: { x: 160, y: 120 },
            size: { width: 280, height: 80 },
        });
        microflow.objectCollection.objects.push(annotation);
        microflow.flows.push(await createAnnotationFlow(sp, annotation.$ID, actionActivity.$ID, 1, 0));
    }

    const importActivityId = importMappingQualifiedName && importMappingOutput
        ? await buildImportBranch(sp, microflow, importMappingQualifiedName, importMappingOutput, commitImportedResult)
        : null;

    let aggregateActivityId: string | null = null;
    let updateCursorActivityId: string | null = null;
    if (importActivityId && persistMaxSequence) {
        const aggregateActivity = await createMicroflowElement<Microflows.ActionActivity>(sp, 'Microflows$ActionActivity');
        const aggregateAction = await createMicroflowElement<Microflows.AggregateListAction>(
            sp,
            'Microflows$AggregateListAction',
            {
                attribute: persistMaxSequence.sequenceAttribute,
                expression: '',
                function: 'Maximum',
                inputVariableName: persistMaxSequence.inputListVariableName,
                outputVariableName: persistMaxSequence.outputVariableName,
            }
        );
        aggregateActivity.action = aggregateAction;
        aggregateActivity.size = { width: 120, height: 60 };
        aggregateActivity.relativeMiddlePoint = { x: 900, y: 200 };
        microflow.objectCollection.objects.push(aggregateActivity);
        aggregateActivityId = aggregateActivity.$ID;

        const updateActivity = await createMicroflowElement<Microflows.ActionActivity>(sp, 'Microflows$ActionActivity');
        const changeObject = await createMicroflowElement<Microflows.ChangeObjectAction>(sp, 'Microflows$ChangeObjectAction');
        const memberChange = await createMicroflowElement<Microflows.MemberChange>(sp, 'Microflows$MemberChange');
        memberChange.attribute = persistMaxSequence.targetAttribute;
        memberChange.type = 'Set';
        memberChange.value =
            `if $${persistMaxSequence.outputVariableName} != empty ` +
            `then formatDecimal($${persistMaxSequence.outputVariableName}, '0') ` +
            `else $${persistMaxSequence.targetObjectVariableName}/${persistMaxSequence.targetAttribute.split('.').at(-1)}`;
        changeObject.changeVariableName = persistMaxSequence.targetObjectVariableName;
        changeObject.commit = 'Yes';
        changeObject.refreshInClient = false;
        changeObject.items = [memberChange];
        updateActivity.action = changeObject;
        updateActivity.size = { width: 120, height: 60 };
        updateActivity.relativeMiddlePoint = { x: 1040, y: 200 };
        microflow.objectCollection.objects.push(updateActivity);
        updateCursorActivityId = updateActivity.$ID;

        const cursorAnnotation = await createMicroflowElement<Microflows.Annotation>(sp, 'Microflows$Annotation', {
            caption: 'Validate and apply every returned batch before updating lastSequenceNumber. Only acknowledge data that was processed successfully.',
            relativeMiddlePoint: { x: 1040, y: 80 },
            size: { width: 320, height: 80 },
        });
        microflow.objectCollection.objects.push(cursorAnnotation);
        microflow.flows.push(await createAnnotationFlow(sp, cursorAnnotation.$ID, updateActivity.$ID, 2, 0));
    }

    const exclusiveSplit = await createMicroflowElement<Microflows.ExclusiveSplit>(sp, 'Microflows$ExclusiveSplit');
    const splitCondition = await createMicroflowElement<Microflows.ExpressionSplitCondition>(sp, 'Microflows$ExpressionSplitCondition');
    splitCondition.expression =
        '$latestHttpResponse/StatusCode >= 200 and $latestHttpResponse/StatusCode < 300';
    exclusiveSplit.splitCondition = splitCondition;
    exclusiveSplit.size = { width: 60, height: 60 };
    exclusiveSplit.relativeMiddlePoint = { x: 600, y: 200 };
    microflow.objectCollection.objects.push(exclusiveSplit);

    const startEvent = await createMicroflowElement<Microflows.StartEvent>(sp, 'Microflows$StartEvent');
    startEvent.relativeMiddlePoint = { x: 100, y: 200 };
    microflow.objectCollection.objects.push(startEvent);

    const endEvent = await createMicroflowElement<Microflows.EndEvent>(
        sp,
        'Microflows$EndEvent',
        returnMappedResult && importMappingOutput
            ? { returnValue: `$${importMappingOutput.outputVariableName}` }
            : {}
    );
    endEvent.relativeMiddlePoint = { x: updateCursorActivityId ? 1360 : importActivityId ? 1100 : 900, y: 200 };
    microflow.objectCollection.objects.push(endEvent);

    if (returnMappedResult && importMappingOutput) {
        const returnDataType = await createMicroflowElement<DataTypes.ListType | DataTypes.ObjectType>(
            sp,
            importMappingOutput.isList ? 'DataTypes$ListType' : 'DataTypes$ObjectType'
        );
        returnDataType.entity = importMappingOutput.entityQualifiedName;
        microflow.microflowReturnType = returnDataType;
    }

    if (exportActivityId) {
        microflow.flows.push(await createSequenceFlow(sp, startEvent.$ID, exportActivityId));
        microflow.flows.push(await createSequenceFlow(sp, exportActivityId, actionActivity.$ID));
    } else if (requestBodyVariableActivityId) {
        microflow.flows.push(await createSequenceFlow(sp, startEvent.$ID, requestBodyVariableActivityId));
        microflow.flows.push(await createSequenceFlow(sp, requestBodyVariableActivityId, actionActivity.$ID));
    } else {
        microflow.flows.push(await createSequenceFlow(sp, startEvent.$ID, actionActivity.$ID));
    }

    microflow.flows.push(await createSequenceFlow(sp, actionActivity.$ID, exclusiveSplit.$ID));
    microflow.flows.push(await createSequenceFlow(sp, actionActivity.$ID, logActivity.$ID, undefined, true, 0, 2));
    microflow.flows.push(await createSequenceFlow(sp, logActivity.$ID, handlerEndEvent.$ID));

    const successActivity = await createMessageActivity(
        sp,
        'Information',
        shouldImportResponse
            ? 'Successfully received and mapped response from i3X API.'
            : 'Successfully received response from i3X API. Response: {1}',
        shouldImportResponse ? [] : ['$ResponseBody']
    );
    successActivity.size = { width: 120, height: 60 };
    successActivity.relativeMiddlePoint = { x: updateCursorActivityId ? 1200 : importActivityId ? 960 : 800, y: 200 };
    microflow.objectCollection.objects.push(successActivity);

    if (importActivityId) {
        microflow.flows.push(await createSequenceFlow(sp, exclusiveSplit.$ID, importActivityId, true));
        if (aggregateActivityId && updateCursorActivityId) {
            microflow.flows.push(await createSequenceFlow(sp, importActivityId, aggregateActivityId));
            microflow.flows.push(await createSequenceFlow(sp, aggregateActivityId, updateCursorActivityId));
            microflow.flows.push(await createSequenceFlow(sp, updateCursorActivityId, successActivity.$ID));
        } else {
            microflow.flows.push(await createSequenceFlow(sp, importActivityId, successActivity.$ID));
        }
        microflow.flows.push(await createSequenceFlow(sp, successActivity.$ID, endEvent.$ID));
    } else {
        microflow.flows.push(await createSequenceFlow(sp, exclusiveSplit.$ID, successActivity.$ID, true));
        microflow.flows.push(await createSequenceFlow(sp, successActivity.$ID, endEvent.$ID));
    }

    const errorX = importActivityId ? 760 : 800;
    const errorActivity = await createMessageActivity(
        sp,
        'Error',
        'Error: Received status code {1} from i3X API.',
        ['toString($latestHttpResponse/StatusCode)']
    );
    errorActivity.size = { width: 120, height: 60 };
    errorActivity.relativeMiddlePoint = { x: errorX, y: 300 };
    microflow.objectCollection.objects.push(errorActivity);
    microflow.flows.push(await createSequenceFlow(sp, exclusiveSplit.$ID, errorActivity.$ID, false));

    const errorEndEvent = await createMicroflowElement<Microflows.EndEvent>(
        sp,
        'Microflows$EndEvent',
        returnMappedResult ? { returnValue: 'empty' } : {}
    );
    errorEndEvent.relativeMiddlePoint = { x: errorX + 100, y: 300 };
    microflow.objectCollection.objects.push(errorEndEvent);
    microflow.flows.push(await createSequenceFlow(sp, errorActivity.$ID, errorEndEvent.$ID));
}
