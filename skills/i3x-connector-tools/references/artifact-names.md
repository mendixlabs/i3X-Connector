# Generated artifact names

`i3x_generate_artifacts` creates everything in the `i3X_Implementation` module. `<Type>` is the object type's display name with every character other than a letter or digit turned into `_`. For example, "Motor Drive" becomes `Motor_Drive`.

| Kind | Artifacts |
|---|---|
| `valueQuery` | Entity `<Type>`, group entities `<Type>_<property>`, JSON structure `JSON_<Type>`, import mapping `IM_<Type>`, microflow `MF_<Type>` |
| `history` | `MF_<Type>_History`, `JSON_<Type>_History`, `IM_<Type>_History` |
| `write` | `MF_<Type>_Write`, export mapping `EM_<Type>_Write`, `JSON_<Type>_Write` |
| `subscription` | `MF_<Type>_SubscribeCreate`, `MF_<Type>_SubscribeRegister`, `MF_<Type>_SubscribeSync`, `MF_<Type>_Unsubscribe`, plus `JSON_` and `IM_` documents for `_SubscribeCreate` and `_SubscribeSync` |

The server URL and credentials live in constants in a `Configuration` folder of `i3X_Implementation`, such as `API_BaseUrl` and `API_Token`. The generated microflows read the constants. To point the app at another server, change the constant values; don't edit the microflows.
