import { NgModule } from '@angular/core'
import {
    ConfigProvider,
    DockingService,
    FileProvider,
    HostAppService,
    HostWindowService,
    LogService,
    PlatformService,
    UpdaterService,
} from 'tlink-core'
import { PTYInterface } from 'tlink-local'

import { ElectronHostAppService } from '../../tlink-electron/src/services/hostApp.service'
import { ElectronHostWindow } from '../../tlink-electron/src/services/hostWindow.service'
import { ElectronPlatformService } from '../../tlink-electron/src/services/platform.service'
import { ElectronLogService } from '../../tlink-electron/src/services/log.service'
import { ElectronUpdaterService } from '../../tlink-electron/src/services/updater.service'
import { ElectronDockingService } from '../../tlink-electron/src/services/docking.service'
import { ElectronFileProvider } from '../../tlink-electron/src/services/fileProvider.service'
import { ElectronPTYInterface } from '../../tlink-electron/src/pty'
import { StudioShellConfigProvider } from './config'
import { StudioWindowThemeSyncService } from './windowThemeSync.service'

@NgModule({
    providers: [
        ElectronHostAppService,
        ElectronHostWindow,
        ElectronPlatformService,
        ElectronLogService,
        ElectronUpdaterService,
        ElectronDockingService,
        ElectronFileProvider,
        { provide: ConfigProvider, useClass: StudioShellConfigProvider, multi: true },
        { provide: HostAppService, useExisting: ElectronHostAppService },
        { provide: HostWindowService, useExisting: ElectronHostWindow },
        { provide: PlatformService, useExisting: ElectronPlatformService },
        { provide: LogService, useExisting: ElectronLogService },
        { provide: UpdaterService, useExisting: ElectronUpdaterService },
        { provide: DockingService, useExisting: ElectronDockingService },
        { provide: FileProvider, useExisting: ElectronFileProvider, multi: true },
        { provide: PTYInterface, useClass: ElectronPTYInterface },
    ],
})
export default class StudioShellModule {
    constructor (
        _windowThemeSync: StudioWindowThemeSyncService,
    ) { }
}
