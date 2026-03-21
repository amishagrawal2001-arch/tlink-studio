import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import deepClone from 'clone-deep'
import { Injectable, Inject, Optional } from '@angular/core'
import { ProfileProvider, NewTabParameters, ConfigService, SplitTabComponent, AppService, PartialProfile } from 'tlink-core'
import { TerminalTabComponent } from './components/terminalTab.component'
import { LocalProfileSettingsComponent } from './components/localProfileSettings.component'
import { ShellProvider, Shell, SessionOptions, LocalProfile } from './api'

@Injectable({ providedIn: 'root' })
export class LocalProfilesService extends ProfileProvider<LocalProfile> {
    id = 'local'
    name = _('Local terminal')
    settingsComponent = LocalProfileSettingsComponent
    configDefaults = {
        options: {
            restoreFromPTYID: null,
            command: '',
            args: [],
            cwd: null,
            env: {
                __nonStructural: true,
            },
            width: null,
            height: null,
            pauseAfterExit: false,
            runAsAdministrator: false,
        },
    }

    constructor (
        private app: AppService,
        private config: ConfigService,
        @Optional() @Inject(ShellProvider) private shellProviders: ShellProvider[]|null,
    ) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<LocalProfile>[]> {
        return (await this.getShells()).map(shell => ({
            id: `local:${shell.id}`,
            type: 'local',
            name: shell.name,
            icon: shell.icon,
            options: this.optionsFromShell(shell),
            isBuiltin: true,
        }))
    }

    async getNewTabParameters (profile: LocalProfile): Promise<NewTabParameters<TerminalTabComponent>> {
        profile = deepClone(profile)

        if (!profile.options.cwd) {
            if (this.app.activeTab instanceof TerminalTabComponent && this.app.activeTab.session) {
                profile.options.cwd = await this.app.activeTab.session.getWorkingDirectory() ?? undefined
            }
            if (this.app.activeTab instanceof SplitTabComponent) {
                const focusedTab = this.app.activeTab.getFocusedTab()

                if (focusedTab instanceof TerminalTabComponent && focusedTab.session) {
                    profile.options.cwd = await focusedTab.session.getWorkingDirectory() ?? undefined
                }
            }
        }

        return {
            type: TerminalTabComponent,
            inputs: {
                profile,
            },
        }
    }

    async getShells (): Promise<Shell[]> {
        const providers = this.shellProviders ?? []
        if (!providers.length) {
            return [this.getFallbackShell()]
        }

        const shellLists = await Promise.all(this.config.enabledServices(providers).map(x => x.provide()))
        const shells = shellLists.reduce((a, b) => a.concat(b), [] as Shell[])
        return shells.length ? shells : [this.getFallbackShell()]
    }

    private getFallbackShell (): Shell {
        if (process.platform === 'win32') {
            return {
                id: 'default',
                name: _('OS default'),
                command: process.env.ComSpec ?? process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
                env: {},
                hidden: true,
            }
        }

        return {
            id: 'default',
            name: _('OS default'),
            command: process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
            args: ['--login'],
            env: {},
            hidden: true,
        }
    }

    optionsFromShell (shell: Shell): SessionOptions {
        return {
            command: shell.command,
            args: shell.args ?? [],
            env: shell.env,
            cwd: shell.cwd,
        }
    }

    getSuggestedName (profile: LocalProfile): string {
        return this.getDescription(profile)
    }

    getDescription (profile: PartialProfile<LocalProfile>): string {
        return profile.options?.command ?? ''
    }
}
