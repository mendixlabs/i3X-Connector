import { ComponentContext } from '@mendix/extensions-api';
import { ObjectType } from './objecttype';
import { ConnectionConfig } from './connection';

export interface LoaderProps {
    context: ComponentContext;
    setApiData: (data: unknown) => void;
    setConnection: (connection: ConnectionConfig) => void;
    // A connection made outside the tab, by the Maia i3x_connect tool. The Loader fills
    // its fields from it and loads the object types.
    sharedConnection: ConnectionConfig | null;
}

export interface ListProps {
    apiData: unknown;
    selectedId: string | null;
    onSelect: (item: ObjectType) => void;
    onCreateObjectsList: () => Promise<void>;
    isCreatingObjectsList: boolean;
}
