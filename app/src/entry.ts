import 'zone.js'
import 'core-js/proposals/reflect-metadata'
import 'rxjs'

import './global.scss'
import './toastr.scss'

// Importing before @angular/*
import { findPlugins, initModuleLookup, loadPlugins } from './plugins'

import { enableProdMode, NgModuleRef, ApplicationRef } from '@angular/core'
import { enableDebugTools } from '@angular/platform-browser'
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'
import { ipcRenderer } from 'electron'

import { getRootModule } from './app.module'
import { BootstrapData, BOOTSTRAP_DATA, PluginInfo } from '../../tlink-core/src/api/mainProcess'

// Always land on the start view
location.hash = ''

;(process as any).enablePromiseAPI = true

if (process.platform === 'win32' && !('HOME' in process.env)) {
    process.env.HOME = `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
}

if (process.env.TLINK_DEV && !process.env.TLINK_FORCE_ANGULAR_PROD) {
    console.warn('Running in debug mode')
} else {
    enableProdMode()
}

const isStudioOnlyApp = (process.env.TLINK_STUDIO_APP ?? '1') === '1'
const STUDIO_PLUGIN_PACKAGES = ['tlink-core', 'tlink-studio-shell']
const STUDIO_PLUGIN_PACKAGE_SET = new Set(STUDIO_PLUGIN_PACKAGES)

function enforceStudioPluginSet (plugins: PluginInfo[]): PluginInfo[] {
    if (!isStudioOnlyApp) {
        return plugins
    }
    const filtered = plugins.filter(plugin => STUDIO_PLUGIN_PACKAGE_SET.has(plugin.packageName))
    const missing = STUDIO_PLUGIN_PACKAGES.filter(packageName => !filtered.some(plugin => plugin.packageName === packageName))
    if (missing.length) {
        throw new Error(`Studio-only mode missing required plugins: ${missing.join(', ')}`)
    }
    const disallowed = plugins.filter(plugin => !STUDIO_PLUGIN_PACKAGE_SET.has(plugin.packageName))
    if (disallowed.length) {
        throw new Error(`Studio-only mode blocked plugins: ${disallowed.map(x => x.packageName).join(', ')}`)
    }
    return filtered
}

function getStudioPlugins (): PluginInfo[] {
    return STUDIO_PLUGIN_PACKAGES.map(packageName => ({
        name: packageName.replace(/^tlink-/, ''),
        description: '',
        packageName,
        isBuiltin: true,
        isLegacy: false,
        version: '0.0.0',
        author: 'Tlink Developers',
        path: packageName,
    }))
}

async function bootstrap (bootstrapData: BootstrapData, plugins: PluginInfo[], safeMode = false): Promise<NgModuleRef<any>> {
    if (safeMode) {
        plugins = plugins.filter(x => x.isBuiltin)
    }

    const pluginModules = await loadPlugins(plugins, (current, total) => {
        const progressBar = document.querySelector<HTMLElement>('.progress .bar')
        if (progressBar) {
            progressBar.style.width = `${100 * current / total}%`
        }
    })

    window['pluginModules'] = pluginModules

    const module = getRootModule(pluginModules)
    const moduleRef = await platformBrowserDynamic([
        { provide: BOOTSTRAP_DATA, useValue: bootstrapData },
    ]).bootstrapModule(module)
    if (process.env.TLINK_DEV) {
        const applicationRef = moduleRef.injector.get(ApplicationRef)
        const [componentRef] = applicationRef.components
        enableDebugTools(componentRef)
    }
    return moduleRef
}

ipcRenderer.once('start', async (_$event, bootstrapData: BootstrapData) => {
    console.log('Window bootstrap data:', bootstrapData)

    if (bootstrapData.windowRole === 'code-editor') {
        ;(window as any).__codeEditorFullWindowMode = true
    }
    if (bootstrapData.windowRole === 'ai-assistant') {
        ;(window as any).__aiAssistantFullWindowMode = true
    }

    initModuleLookup(bootstrapData.userPluginsPath)

    let plugins = isStudioOnlyApp ? enforceStudioPluginSet(getStudioPlugins()) : await findPlugins()
    if (bootstrapData.config.pluginBlacklist && !isStudioOnlyApp) {
        plugins = plugins.filter(x => !bootstrapData.config.pluginBlacklist.includes(x.name))
    }
    plugins = isStudioOnlyApp ? enforceStudioPluginSet(plugins) : plugins
    if (!isStudioOnlyApp) {
        plugins = plugins.filter(x => x.name !== 'web')
    }
    bootstrapData.installedPlugins = plugins

    console.log('Starting with plugins:', plugins)
    try {
        await bootstrap(bootstrapData, plugins)
    } catch (error) {
        console.error('Angular bootstrapping error:', error)
        console.warn('Trying safe mode')
        window['safeModeReason'] = error
        try {
            await bootstrap(bootstrapData, plugins, true)
        } catch (error2) {
            console.error('Bootstrap failed:', error2)
        }
    }
})

ipcRenderer.send('ready')
