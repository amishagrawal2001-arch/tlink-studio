import { Injectable } from '@angular/core'
import { ConfigService, ThemesService } from 'tlink-core'
import { ElectronService } from '../../tlink-electron/src/services/electron.service'

@Injectable({ providedIn: 'root' })
export class StudioWindowThemeSyncService {
    constructor (
        private config: ConfigService,
        private themes: ThemesService,
        private electron: ElectronService,
    ) {
        config.ready$.toPromise().then(() => {
            this.updateDarkMode()
            this.updateWindowControlsColor()
        })

        config.changed$.subscribe(() => {
            this.updateDarkMode()
            this.updateWindowControlsColor()
        })

        themes.themeChanged$.subscribe(() => {
            this.updateWindowControlsColor()
        })
    }

    private updateDarkMode (): void {
        const colorSchemeMode = this.config.store?.appearance?.colorSchemeMode ?? 'auto'
        this.electron.ipcRenderer.send('window-set-dark-mode', colorSchemeMode)
    }

    private updateWindowControlsColor (): void {
        const colorScheme = this.themes._getActiveColorScheme?.()
        if (colorScheme) {
            this.electron.ipcRenderer.send('window-set-window-controls-color', colorScheme)
        }
    }
}
