import { ComponentContext } from '@mendix/extensions-api';
import { ObjectType } from './objecttype';
import { ConnectionConfig } from './connection';

export interface LoaderProps {
    context: ComponentContext;
    setApiData: (data: unknown) => void;
    setConnection: (connection: ConnectionConfig) => void;
}

export interface ListProps {
    apiData: unknown;
    selectedId: string | null;
    onSelect: (item: ObjectType) => void;
    onCreateObjectsList: () => Promise<void>;
    isCreatingObjectsList: boolean;
}
