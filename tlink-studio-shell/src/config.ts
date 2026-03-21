import { ConfigProvider, Platform } from 'tlink-core'

/** @hidden */
export class StudioShellConfigProvider extends ConfigProvider {
    defaults = {
        appearance: {
            colorSchemeMode: 'auto',
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                'cycle-color-scheme': ['⌘-Shift-L'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                'cycle-color-scheme': ['Ctrl-Shift-L'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                'cycle-color-scheme': ['Ctrl-Shift-L'],
            },
        },
    }
}
