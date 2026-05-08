import type { DataTypes, Microflows, StudioProApi, Texts } from '@mendix/extensions-api';
import { configureHttpAuthForMicroflow, type AuthConstantRefs } from './auth';

export interface RestMicroflowOptions {
    url: string;
    urlArgs?: string[];
    requestBody: string;
    requestBodyArgs?: string[];
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

async function addHttpHeadersToConfiguration(
    sp: StudioProApi,
    httpConfiguration: Microflows.HttpConfiguration,
    headers: Array<{ key: string; value: string }>
): Promise<void> {
    for (const { key, value } of headers) {
        const headerEntry = (await sp.app.model.microflows.createElement(
            'Microflows$HttpHeaderEntry'
        )) as Microflows.HttpHeaderEntry;
        headerEntry.key = key;
        headerEntry.value = value;
        httpConfiguration.headerEntries.push(headerEntry);
    }
}

async function createSequenceFlow(
    sp: StudioProApi,
    startId: string,
    endId: string,
    exclusiveSplitValue?: boolean
): Promise<Microflows.SequenceFlow> {
    const sequenceFlow = (await sp.app.model.microflows.createElement(
        'Microflows$SequenceFlow'
    )) as Microflows.SequenceFlow;
    sequenceFlow.origin = startId;
    sequenceFlow.destination = endId;
    if (exclusiveSplitValue !== undefined) {
        const caseValue = (await sp.app.model.microflows.createElement(
            'Microflows$EnumerationCase'
        )) as Microflows.EnumerationCase;
        caseValue.value = exclusiveSplitValue ? 'true' : 'false';
        sequenceFlow.caseValues = [caseValue];
    }
    return sequenceFlow;
}

async function createAnnotationFlow(
    sp: StudioProApi,
    annotationId: string,
    targetId: string
): Promise<Microflows.AnnotationFlow> {
    const annotationFlow = (await sp.app.model.microflows.createElement(
        'Microflows$AnnotationFlow'
    )) as Microflows.AnnotationFlow;
    annotationFlow.origin = annotationId;
    annotationFlow.destination = targetId;
    return annotationFlow;
}

async function createMessageActivity(
    sp: StudioProApi,
    type: Microflows.ShowMessageType,
    messageText: string,
    expressionArgs: string[],
    languageCode: string
): Promise<Microflows.ActionActivity> {
    const messageActivity = (await sp.app.model.microflows.createElement(
        'Microflows$ActionActivity'
    )) as Microflows.ActionActivity;
    const showMessage = (await sp.app.model.microflows.createElement(
        'Microflows$ShowMessageAction'
    )) as Microflows.ShowMessageAction;
    const textTemplate = (await sp.app.model.microflows.createElement(
        'Microflows$TextTemplate'
    )) as Microflows.TextTemplate;
    const text = (await sp.app.model.microflows.createElement('Texts$Text')) as Texts.Text;
    const translation = (await sp.app.model.microflows.createElement(
        'Texts$Translation'
    )) as Texts.Translation;

    for (const arg of expressionArgs) {
        const templateArg = (await sp.app.model.microflows.createElement(
            'Microflows$TemplateArgument'
        )) as Microflows.TemplateArgument;
        templateArg.expression = arg;
        textTemplate.arguments.push(templateArg);
    }

    translation.languageCode = languageCode;
    translation.text = messageText;
    text.translations.push(translation);

    textTemplate.text = text;
    showMessage.type = type;
    showMessage.template = textTemplate;
    messageActivity.action = showMessage;
    return messageActivity;
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
        extraHeaders = [],
        authRefs,
        importMappingQualifiedName,
        importMappingOutput,
        exportMapping,
        annotationText,
        returnMappedResult,
    } = options;
    const shouldImportResponse = Boolean(importMappingQualifiedName && importMappingOutput);

    const actionActivity = (await sp.app.model.microflows.createElement(
        'Microflows$ActionActivity'
    )) as Microflows.ActionActivity;
    const restCall = (await sp.app.model.microflows.createElement(
        'Microflows$RestCallAction'
    )) as Microflows.RestCallAction;
    const httpConfiguration = (await sp.app.model.microflows.createElement(
        'Microflows$HttpConfiguration'
    )) as Microflows.HttpConfiguration;
    const locationTemplate = (await sp.app.model.microflows.createElement(
        'Microflows$StringTemplate'
    )) as Microflows.StringTemplate;
    const locationTemplateArg = (await sp.app.model.microflows.createElement(
        'Microflows$TemplateArgument'
    )) as Microflows.TemplateArgument;
    const resultHandling = (await sp.app.model.microflows.createElement(
        'Microflows$ResultHandling'
    )) as Microflows.ResultHandling;
    const stringType = await sp.app.model.microflows.createElement('DataTypes$StringType');

    // ExportXmlAction ID is needed for sequence-flow wiring further down.
    let exportActivityId: string | null = null;

    if (exportMapping) {
        // MappingRequestHandling can only be contained in ExportXmlAction, not RestCallAction.
        // The correct pattern: ExportXmlAction serialises the entity to $SerializedJson,
        // then RestCallAction reads $SerializedJson via CustomRequestHandling.
        const exportActivity = (await sp.app.model.microflows.createElement(
            'Microflows$ActionActivity'
        )) as Microflows.ActionActivity;
        const exportXmlAction = (await sp.app.model.microflows.createElement(
            'Microflows$ExportXmlAction'
        )) as Microflows.ExportXmlAction;
        const exportResultHandling = (await sp.app.model.microflows.createElement(
            'Microflows$MappingRequestHandling'
        )) as Microflows.MappingRequestHandling;
        const variableExport = (await sp.app.model.microflows.createElement(
            'Microflows$VariableExport'
        )) as Microflows.VariableExport;

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
        exportActivityId = exportActivity.$ID;

        const requestHandler = (await sp.app.model.microflows.createElement(
            'Microflows$CustomRequestHandling'
        )) as Microflows.CustomRequestHandling;
        const requestTemplate = (await sp.app.model.microflows.createElement(
            'Microflows$StringTemplate'
        )) as Microflows.StringTemplate;
        requestTemplate.text = '{1}';
        const serializedJsonArg = (await sp.app.model.microflows.createElement(
            'Microflows$TemplateArgument'
        )) as Microflows.TemplateArgument;
        serializedJsonArg.expression = '$SerializedJson';
        requestTemplate.arguments.push(serializedJsonArg);
        requestHandler.template = requestTemplate;
        restCall.requestHandling = requestHandler;
        restCall.requestHandlingType = 'Custom';
    } else {
        const requestHandler = (await sp.app.model.microflows.createElement(
            'Microflows$CustomRequestHandling'
        )) as Microflows.CustomRequestHandling;
        const requestTemplate = (await sp.app.model.microflows.createElement(
            'Microflows$StringTemplate'
        )) as Microflows.StringTemplate;
        requestTemplate.text = requestBody;
        for (const argExpr of requestBodyArgs) {
            const templateArg = (await sp.app.model.microflows.createElement(
                'Microflows$TemplateArgument'
            )) as Microflows.TemplateArgument;
            templateArg.expression = argExpr;
            requestTemplate.arguments.push(templateArg);
        }
        requestHandler.template = requestTemplate;
        restCall.requestHandling = requestHandler;
        restCall.requestHandlingType = 'Custom';
    }

    httpConfiguration.overrideLocation = true;
    if (urlArgs.length > 0) {
        locationTemplate.text = url;
        const locationTemplateArgs: Microflows.TemplateArgument[] = [];
        for (const argExpr of urlArgs) {
            const templateArg = (await sp.app.model.microflows.createElement(
                'Microflows$TemplateArgument'
            )) as Microflows.TemplateArgument;
            templateArg.expression = argExpr;
            locationTemplateArgs.push(templateArg);
        }
        locationTemplate.arguments = locationTemplateArgs;
    } else {
        locationTemplate.text = '{1}';
        locationTemplateArg.expression = `'${url}'`;
        locationTemplate.arguments = [locationTemplateArg];
    }
    httpConfiguration.customLocationTemplate = locationTemplate;
    await configureHttpAuthForMicroflow(sp, httpConfiguration, authRefs);
    await addHttpHeadersToConfiguration(sp, httpConfiguration, extraHeaders);
    restCall.httpConfiguration = httpConfiguration;

    resultHandling.variableType = stringType as typeof resultHandling.variableType;
    resultHandling.storeInVariable = true;
    resultHandling.outputVariableName = 'ResponseBody';
    restCall.resultHandlingType = 'String';

    restCall.resultHandling = resultHandling;
    restCall.errorResultHandlingType = 'None';
    restCall.timeOutExpression = '300';

    actionActivity.action = restCall;
    actionActivity.size = { width: 120, height: 60 };
    actionActivity.relativeMiddlePoint = { x: 400, y: 200 };
    microflow.objectCollection.objects.push(actionActivity);

    if (annotationText) {
        const annotation = await microflow.objectCollection.addAnnotation({
            caption: annotationText,
            relativeMiddlePoint: { x: 400, y: 60 },
            size: { width: 360, height: 110 },
        });
        microflow.flows.push(await createAnnotationFlow(sp, annotation.$ID, actionActivity.$ID));
    }

    // Separate ImportXmlAction activity on the success branch — mirrors how ExportXmlAction
    // is used before the REST call on the write side, with contentType 'Json' for JSON mappings.
    let importActivityId: string | null = null;
    if (importMappingQualifiedName && importMappingOutput) {
        const importActivity = (await sp.app.model.microflows.createElement(
            'Microflows$ActionActivity'
        )) as Microflows.ActionActivity;
        const importXmlAction = (await sp.app.model.microflows.createElement(
            'Microflows$ImportXmlAction'
        )) as Microflows.ImportXmlAction;
        const importResultHandling = (await sp.app.model.microflows.createElement(
            'Microflows$ResultHandling'
        )) as Microflows.ResultHandling;
        const importMappingCall = (await sp.app.model.microflows.createElement(
            'Microflows$ImportMappingCall'
        )) as Microflows.ImportMappingCall;
        const importRange = (await sp.app.model.microflows.createElement(
            'Microflows$ConstantRange'
        )) as Microflows.ConstantRange;
        const importVariableType = (await sp.app.model.microflows.createElement(
            importMappingOutput.isList ? 'DataTypes$ListType' : 'DataTypes$ObjectType'
        )) as typeof resultHandling.variableType;

        importRange.singleObject = !importMappingOutput.isList;
        importMappingCall.commit = 'No';
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
        importActivityId = importActivity.$ID;
    }

    const exclusiveSplit = (await sp.app.model.microflows.createElement(
        'Microflows$ExclusiveSplit'
    )) as Microflows.ExclusiveSplit;
    const splitCondition = (await sp.app.model.microflows.createElement(
        'Microflows$ExpressionSplitCondition'
    )) as Microflows.ExpressionSplitCondition;
    splitCondition.expression = '$latestHttpResponse/StatusCode = 200';
    exclusiveSplit.splitCondition = splitCondition;
    exclusiveSplit.size = { width: 60, height: 60 };
    exclusiveSplit.relativeMiddlePoint = { x: 600, y: 200 };
    microflow.objectCollection.objects.push(exclusiveSplit);

    const startEvent = (await sp.app.model.microflows.createElement(
        'Microflows$StartEvent'
    )) as Microflows.StartEvent;
    startEvent.relativeMiddlePoint = { x: 100, y: 200 };
    microflow.objectCollection.objects.push(startEvent);

    const endEvent = await microflow.objectCollection.addEndEvent(
        returnMappedResult && importMappingOutput
            ? { returnValue: `$${importMappingOutput.outputVariableName}` }
            : {}
    );
    endEvent.relativeMiddlePoint = { x: importActivityId ? 1100 : 900, y: 200 };

    if (returnMappedResult && importMappingOutput) {
        const returnDataType = (await sp.app.model.microflows.createElement(
            importMappingOutput.isList ? 'DataTypes$ListType' : 'DataTypes$ObjectType'
        )) as DataTypes.ListType | DataTypes.ObjectType;
        returnDataType.entity = importMappingOutput.entityQualifiedName;
        microflow.microflowReturnType = returnDataType;
    }
    
    if (exportActivityId) {
        microflow.flows.push(await createSequenceFlow(sp, startEvent.$ID, exportActivityId));
        microflow.flows.push(await createSequenceFlow(sp, exportActivityId, actionActivity.$ID));
    } else {
        microflow.flows.push(await createSequenceFlow(sp, startEvent.$ID, actionActivity.$ID));
    }

    microflow.flows.push(await createSequenceFlow(sp, actionActivity.$ID, exclusiveSplit.$ID));

    const successActivity = await createMessageActivity(
        sp,
        'Information',
        shouldImportResponse
            ? 'Successfully received and mapped response from i3X API.'
            : 'Successfully received response from i3X API. Response: {1}',
        shouldImportResponse ? [] : ['$ResponseBody'],
        'en_US'
    );
    successActivity.size = { width: 120, height: 60 };
    successActivity.relativeMiddlePoint = { x: importActivityId ? 960 : 800, y: 200 };
    microflow.objectCollection.objects.push(successActivity);

    if (importActivityId) {
        microflow.flows.push(await createSequenceFlow(sp, exclusiveSplit.$ID, importActivityId, true));
        microflow.flows.push(await createSequenceFlow(sp, importActivityId, successActivity.$ID));
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
        ['toString($latestHttpResponse/StatusCode)'],
        'en_US'
    );
    errorActivity.size = { width: 120, height: 60 };
    errorActivity.relativeMiddlePoint = { x: errorX, y: 300 };
    microflow.objectCollection.objects.push(errorActivity);
    microflow.flows.push(await createSequenceFlow(sp, exclusiveSplit.$ID, errorActivity.$ID, false));

    const errorEndEvent = await microflow.objectCollection.addEndEvent(
        returnMappedResult ? { returnValue: 'empty' } : {}
    );
    errorEndEvent.relativeMiddlePoint = { x: errorX + 100, y: 300 };
    microflow.flows.push(await createSequenceFlow(sp, errorActivity.$ID, errorEndEvent.$ID));
}